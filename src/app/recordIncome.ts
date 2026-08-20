import { z } from "zod";
import { eq } from "drizzle-orm";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { recordIncome as recordIncomeDomain } from "../domain/commands/recordIncome.js";
import { buildExpectedFundingCycle } from "../domain/funding/cycles.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import { tables, anyDb, queryGet } from "../db/exec.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { persistExpectedFundingCycle } from "./salaryPolicy.js";
import { assertWorkspaceOwned } from "./ownership.js";
import { DomainError, type FundingCycleRecord, type LedgerSnapshot } from "../domain/ledger/types.js";
import { withWorkspaceSalaryWriteLock } from "../db/salaryWriteLock.js";

const inputSchema = z.object({
  commandId: z.string().min(1).optional(),
  occurredOn: z.string(),
  capturedAt: z.string(),
  amountPaise: z.number().int().positive(),
  accountId: z.string().min(1),
  kind: z.enum(["salary", "other"]),
  notes: z.string().nullable().optional(),
  fundingCycleId: z.string().min(1).optional().or(z.literal("")),
  expectedYear: z.number().int().optional(),
  expectedMonth: z.number().int().min(1).max(12).optional(),
  commit: z.boolean().default(true),
});

type IncomeInput = z.infer<typeof inputSchema>;

type CycleIdentity = {
  fundingCycleId?: string;
  expectedYear?: number;
  expectedMonth?: number;
};

function cycleIdentity(input: IncomeInput): CycleIdentity | null {
  const fundingCycleId = input.fundingCycleId || undefined;
  const hasYear = input.expectedYear !== undefined;
  const hasMonth = input.expectedMonth !== undefined;
  if (hasYear !== hasMonth) {
    throw new DomainError("invalid_salary_schedule", "Expected salary period needs both year and month");
  }
  if (!fundingCycleId && !hasYear) return null;
  return {
    fundingCycleId,
    expectedYear: input.expectedYear,
    expectedMonth: input.expectedMonth,
  };
}

export async function recordIncome(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  const identity = input.kind === "salary" ? cycleIdentity(input) : null;

  const run = async (tx: DbHandles) => {
    await assertWorkspaceOwned(tx, context.workspaceId, [{ type: "account", id: input.accountId }]);

    const t = tables(tx);
    if (input.commandId) {
      const existingEvent = await anyDb(tx)
        .select()
        .from(t.financialEvents)
        .where(eq(t.financialEvents.id, input.commandId))
        .limit(1);
      if (existingEvent.length > 0) {
        return replayOrConflict(tx, context.workspaceId, input, existingEvent[0]!, identity);
      }
    }

    const occurredOn = isoDate(input.occurredOn);
    let snapshot = await loadSnapshot(tx, context.workspaceId, occurredOn);
    let resolvedCycle: FundingCycleRecord | undefined;

    if (identity) {
      const cycle = await resolveSalaryCycle(tx, context.workspaceId, snapshot, identity, input.commit);
      resolvedCycle = cycle;
      if (!snapshot.fundingCycles.some((item) => item.id === cycle.id)) {
        snapshot = {
          ...snapshot,
          fundingCycles: [...snapshot.fundingCycles, cycle],
        };
      }
    }

    const result = recordIncomeDomain(
      {
        commandId: input.commandId,
        occurredOn,
        capturedAt: input.capturedAt,
        amountPaise: paise(input.amountPaise),
        accountId: input.accountId,
        kind: input.kind,
        notes: input.notes,
        fundingCycleId: resolvedCycle?.id,
      },
      snapshot,
    );

    if (input.commit) {
      try {
        await persistBatch(tx, context.workspaceId, result.batch);
      } catch (caught) {
        const err = caught as { message?: string; code?: string };
        if (input.commandId && (err.message?.includes("UNIQUE") || err.code === "23505")) {
          const check = await anyDb(tx)
            .select()
            .from(t.financialEvents)
            .where(eq(t.financialEvents.id, input.commandId))
            .limit(1);
          if (check.length > 0) {
            return replayOrConflict(tx, context.workspaceId, input, check[0]!, identity);
          }
        }
        throw err;
      }
    }

    return {
      preview: result.preview,
      eventId: result.batch.events[0]?.id ?? null,
      committed: input.commit,
    };
  };

  if (input.commit && identity) {
    return withWorkspaceSalaryWriteLock(handles, context.workspaceId, run);
  }
  return run(handles);
}

async function resolveSalaryCycle(
  handles: DbHandles,
  workspaceId: string,
  snapshot: LedgerSnapshot,
  identity: CycleIdentity,
  commit: boolean,
): Promise<FundingCycleRecord> {
  if (identity.fundingCycleId) {
    const existing = snapshot.fundingCycles.find((cycle) => cycle.id === identity.fundingCycleId);
    if (!existing) {
      throw new DomainError("cycle_not_found", "Salary period not found");
    }
    if (
      identity.expectedYear !== undefined &&
      (existing.year !== identity.expectedYear || existing.month !== identity.expectedMonth)
    ) {
      throw new DomainError("cycle_not_found", "Salary period does not match the selected month");
    }
    return existing;
  }

  const year = identity.expectedYear!;
  const month = identity.expectedMonth!;
  const existing = snapshot.fundingCycles.find((cycle) => cycle.year === year && cycle.month === month);
  if (existing) return existing;

  if (!commit) {
    const overlay = buildExpectedFundingCycle(snapshot.incomePolicies, year, month);
    if (!overlay) {
      throw new DomainError(
        "invalid_salary_schedule",
        "That salary period is not covered by the current schedule",
      );
    }
    return overlay;
  }

  return persistExpectedFundingCycle(handles, workspaceId, snapshot, year, month);
}

async function replayOrConflict(
  handles: DbHandles,
  workspaceId: string,
  input: IncomeInput,
  existing: { workspaceId: string; meaning: string; amountPaise: number; accountId: string | null; occurredOn: string },
  identity: CycleIdentity | null,
) {
  if (existing.workspaceId !== workspaceId) {
    throw new DomainError("idempotency_conflict", "Command ID conflict");
  }
  if (existing.meaning !== "income") {
    throw new DomainError("idempotency_conflict", "commandId exists with different meaning");
  }
  const t = tables(handles);
  const postings = await anyDb(handles).select().from(t.postings).where(eq(t.postings.eventId, input.commandId)).limit(8);
  const salaryPosting = postings.find((row: { pnl: string | null }) => row.pnl === "income_salary" || row.pnl === "income_other");
  const existingKind = salaryPosting?.pnl === "income_salary" ? "salary" : salaryPosting?.pnl === "income_other" ? "other" : null;
  const linkedCycle = input.commandId
    ? await queryGet<{ id: string; workspaceId: string; year: number; month: number }>(
        handles,
        anyDb(handles)
          .select({
            id: t.fundingCycles.id,
            workspaceId: t.fundingCycles.workspaceId,
            year: t.fundingCycles.year,
            month: t.fundingCycles.month,
          })
          .from(t.fundingCycles)
          .where(eq(t.fundingCycles.salaryEventId, input.commandId)),
      )
    : undefined;
  if (linkedCycle && linkedCycle.workspaceId !== workspaceId) {
    throw new DomainError("idempotency_conflict", "Command ID conflict");
  }
  if (
    existing.amountPaise !== input.amountPaise ||
    existing.accountId !== input.accountId ||
    existing.occurredOn !== input.occurredOn ||
    existingKind !== input.kind
  ) {
    throw new DomainError("idempotency_conflict", "commandId exists with different payload");
  }
  assertReplayCycleIdentity(linkedCycle ?? null, identity);
  return { preview: null, eventId: input.commandId, committed: true };
}

function assertReplayCycleIdentity(
  original: { id: string; year: number; month: number } | null,
  retry: CycleIdentity | null,
): void {
  if (!original) {
    if (retry) {
      throw new DomainError("idempotency_conflict", "commandId exists with different payload");
    }
    return;
  }
  if (!retry) {
    throw new DomainError("idempotency_conflict", "commandId exists with different payload");
  }
  if (retry.fundingCycleId !== undefined && retry.fundingCycleId !== original.id) {
    throw new DomainError("idempotency_conflict", "commandId exists with different payload");
  }
  if (retry.expectedYear !== undefined && retry.expectedYear !== original.year) {
    throw new DomainError("idempotency_conflict", "commandId exists with different payload");
  }
  if (retry.expectedMonth !== undefined && retry.expectedMonth !== original.month) {
    throw new DomainError("idempotency_conflict", "commandId exists with different payload");
  }
}
