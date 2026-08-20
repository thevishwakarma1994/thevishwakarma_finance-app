import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { todayKolkata } from "../domain/calendar/kolkata.js";
import {
  buildExpectedFundingCycle,
  enrichFundingCycles,
  materializeFundingCycles,
  policyAsOf,
  typicalOnForCycle,
} from "../domain/funding/cycles.js";
import { paise } from "../domain/money/paise.js";
import {
  parseSalaryEffectiveFrom,
  planSalaryPolicyVersion,
  validateSalaryPolicyInput,
} from "../domain/commands/salaryPolicy.js";
import type { FundingCycleRecord, IncomePolicy } from "../domain/ledger/types.js";
import { DomainError } from "../domain/ledger/types.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import { tables, anyDb, queryRun } from "../db/exec.js";
import { withWorkspaceSalaryWriteLock } from "../db/salaryWriteLock.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { eq, and } from "drizzle-orm";

const policyInputSchema = z.object({
  expectedAmountPaise: z.number().int().positive(),
  windowStartDay: z.number().int(),
  typicalDay: z.number().int(),
  windowEndDay: z.number().int(),
  effectiveFrom: z.string(),
});

export async function applySalaryPolicy(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = policyInputSchema.parse(raw);
  validateSalaryPolicyInput(input);
  const effectiveFrom = parseSalaryEffectiveFrom(input.effectiveFrom);

  return withWorkspaceSalaryWriteLock(handles, context.workspaceId, async (tx) => {
    const snapshot = await loadSnapshot(tx, context.workspaceId, effectiveFrom);
    const plan = planSalaryPolicyVersion(
      snapshot.incomePolicies,
      {
        expectedAmountPaise: paise(input.expectedAmountPaise),
        windowStartDay: input.windowStartDay,
        typicalDay: input.typicalDay,
        windowEndDay: input.windowEndDay,
        effectiveFrom,
      },
      snapshot.fundingCycles,
    );

    const t = tables(tx);
    if (plan.close) {
      await queryRun(
        tx,
        anyDb(tx)
          .update(t.incomePolicies)
          .set({ effectiveTo: plan.close.effectiveTo })
          .where(eq(t.incomePolicies.id, plan.close.id)),
      );
    }
    if (plan.update) {
      await queryRun(
        tx,
        anyDb(tx)
          .update(t.incomePolicies)
          .set({
            expectedAmountPaise: plan.update.expectedAmountPaise,
            windowStartDay: plan.update.windowStartDay,
            typicalDay: plan.update.typicalDay,
            windowEndDay: plan.update.windowEndDay,
          })
          .where(and(eq(t.incomePolicies.id, plan.update.id), eq(t.incomePolicies.workspaceId, context.workspaceId))),
      );
    }
    if (plan.insert) {
      await queryRun(
        tx,
        anyDb(tx).insert(t.incomePolicies).values({
          id: plan.insert.id,
          workspaceId: context.workspaceId,
          expectedAmountPaise: plan.insert.expectedAmountPaise,
          windowStartDay: plan.insert.windowStartDay,
          typicalDay: plan.insert.typicalDay,
          windowEndDay: plan.insert.windowEndDay,
          effectiveFrom: plan.insert.effectiveFrom,
          effectiveTo: plan.insert.effectiveTo,
        }),
      );
    }

    return { policyId: plan.update?.id ?? plan.insert?.id ?? null };
  });
}

export async function salarySchedule(
  handles: DbHandles,
  context: WorkspaceContext,
  asOf = todayKolkata(),
) {
  const occurredOn = isoDate(asOf);
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  const policy = policyAsOf(snapshot.incomePolicies, occurredOn);
  const persistedIds = new Set(snapshot.fundingCycles.map((cycle) => cycle.id));
  const materialized = materializeFundingCycles(snapshot.incomePolicies, snapshot.fundingCycles, occurredOn);
  const cycles = enrichFundingCycles(materialized, occurredOn);
  const receivable = cycles.filter(
    (cycle) =>
      cycle.salaryEventId === null &&
      (cycle.status === "upcoming" ||
        cycle.status === "window_open_unreceived" ||
        cycle.status === "salary_delayed"),
  );
  const next =
    receivable.find((cycle) => cycle.status === "window_open_unreceived") ??
    receivable.find((cycle) => cycle.status === "salary_delayed") ??
    receivable.find((cycle) => cycle.status === "upcoming") ??
    null;
  const primary = snapshot.accounts.find((account) => account.isPrimarySalary && account.status === "active") ?? null;

  return {
    primarySalaryAccount: primary
      ? { id: primary.id, displayName: primary.displayName, kind: primary.kind }
      : null,
    policy: policy
      ? {
          expectedAmountPaise: policy.expectedAmountPaise,
          windowStartDay: policy.windowStartDay,
          typicalDay: policy.typicalDay,
          windowEndDay: policy.windowEndDay,
          effectiveFrom: policy.effectiveFrom,
        }
      : null,
    nextExpected: next ? presentCycle(next, snapshot.incomePolicies, persistedIds) : null,
    receivableCycles: receivable.map((cycle) => presentCycle(cycle, snapshot.incomePolicies, persistedIds)),
  };
}

/**
 * Persist the expected funding cycle for one year/month if missing.
 * Write-path only: salary receipt and explicit ensure. Never called from GET.
 */
export async function ensureExpectedFundingCycle(
  handles: DbHandles,
  workspaceId: string,
  year: number,
  month: number,
): Promise<FundingCycleRecord> {
  return withWorkspaceSalaryWriteLock(handles, workspaceId, async (tx) => {
    const snapshot = await loadSnapshot(tx, workspaceId);
    return persistExpectedFundingCycle(tx, workspaceId, snapshot, year, month);
  });
}

export async function persistExpectedFundingCycle(
  handles: DbHandles,
  workspaceId: string,
  snapshot: Awaited<ReturnType<typeof loadSnapshot>>,
  year: number,
  month: number,
): Promise<FundingCycleRecord> {
  const existing = snapshot.fundingCycles.find((cycle) => cycle.year === year && cycle.month === month);
  if (existing) return existing;
  const created = buildExpectedFundingCycle(snapshot.incomePolicies, year, month);
  if (!created) {
    throw new DomainError(
      "invalid_salary_schedule",
      "That salary period is not covered by the current schedule",
    );
  }
  try {
    await persistBatch(handles, workspaceId, {
      events: [],
      postings: [],
      openings: [],
      fundingCycles: [created],
    });
    return created;
  } catch (caught) {
    const err = caught as { message?: string; code?: string };
    if (!(err.message?.includes("UNIQUE") || err.code === "23505")) {
      throw err;
    }
    const retried = await loadSnapshot(handles, workspaceId);
    const winner = retried.fundingCycles.find((cycle) => cycle.year === year && cycle.month === month);
    if (!winner) throw caught;
    return winner;
  }
}

function presentCycle(
  cycle: ReturnType<typeof enrichFundingCycles>[number],
  policies: IncomePolicy[],
  persistedIds: Set<string>,
) {
  const policy = policyAsOf(policies, cycle.expectedWindowStart);
  return {
    fundingCycleId: persistedIds.has(cycle.id) ? cycle.id : null,
    year: cycle.year,
    month: cycle.month,
    typicalOn: typicalOnForCycle(cycle, policy),
    windowStart: cycle.expectedWindowStart,
    windowEnd: cycle.expectedWindowEnd,
    expectedAmountPaise: cycle.expectedAmountSnapshot,
    status: cycle.status,
  };
}
