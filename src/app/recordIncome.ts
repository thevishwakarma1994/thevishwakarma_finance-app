import { z } from "zod";
import { eq } from "drizzle-orm";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { recordIncome as recordIncomeDomain } from "../domain/commands/recordIncome.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import { tables, anyDb, queryGet } from "../db/exec.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";
import { DomainError } from "../domain/ledger/types.js";
import { withFundingCycleWriteLock } from "../db/salaryWriteLock.js";

const inputSchema = z.object({
  commandId: z.string().min(1).optional(),
  occurredOn: z.string(),
  capturedAt: z.string(),
  amountPaise: z.number().int().positive(),
  accountId: z.string().min(1),
  kind: z.enum(["salary", "other"]),
  notes: z.string().nullable().optional(),
  fundingCycleId: z.string().min(1).optional().or(z.literal("")),
  commit: z.boolean().default(true),
});

export async function recordIncome(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  const fundingCycleId = input.fundingCycleId || undefined;

  const run = async (tx: DbHandles) => {
    const refs: { type: "account" | "cycle"; id: string }[] = [{ type: "account", id: input.accountId }];
    await assertWorkspaceOwned(tx, context.workspaceId, refs);

    const t = tables(tx);
    if (input.commandId) {
      const existingEvent = await anyDb(tx)
        .select()
        .from(t.financialEvents)
        .where(eq(t.financialEvents.id, input.commandId))
        .limit(1);
      if (existingEvent.length > 0) {
        return replayOrConflict(tx, context.workspaceId, input, existingEvent[0]!);
      }
    }

    const occurredOn = isoDate(input.occurredOn);
    const snapshot = await loadSnapshot(tx, context.workspaceId, occurredOn);
    const result = recordIncomeDomain(
      {
        commandId: input.commandId,
        occurredOn,
        capturedAt: input.capturedAt,
        amountPaise: paise(input.amountPaise),
        accountId: input.accountId,
        kind: input.kind,
        notes: input.notes,
        fundingCycleId,
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
            return replayOrConflict(tx, context.workspaceId, input, check[0]!);
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

  if (input.commit && input.kind === "salary" && fundingCycleId) {
    return withFundingCycleWriteLock(handles, context.workspaceId, fundingCycleId, run);
  }
  return run(handles);
}

async function replayOrConflict(
  handles: DbHandles,
  workspaceId: string,
  input: z.infer<typeof inputSchema>,
  existing: { workspaceId: string; meaning: string; amountPaise: number; accountId: string | null; occurredOn: string },
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
  // financial_events has no funding_cycle_id column; the receipt↔cycle link lives on
  // funding_cycles.salary_event_id. Recover it so payload identity includes the cycle.
  const linkedCycle = input.commandId
    ? await queryGet<{ id: string; workspaceId: string }>(
        handles,
        anyDb(handles)
          .select({ id: t.fundingCycles.id, workspaceId: t.fundingCycles.workspaceId })
          .from(t.fundingCycles)
          .where(eq(t.fundingCycles.salaryEventId, input.commandId)),
      )
    : undefined;
  if (linkedCycle && linkedCycle.workspaceId !== workspaceId) {
    throw new DomainError("idempotency_conflict", "Command ID conflict");
  }
  const existingFundingCycleId = linkedCycle?.id ?? null;
  const fundingCycleId = input.fundingCycleId || null;
  if (
    existing.amountPaise !== input.amountPaise ||
    existing.accountId !== input.accountId ||
    existing.occurredOn !== input.occurredOn ||
    existingFundingCycleId !== fundingCycleId ||
    existingKind !== input.kind
  ) {
    throw new DomainError("idempotency_conflict", "commandId exists with different payload");
  }
  return { preview: null, eventId: input.commandId, committed: true };
}
