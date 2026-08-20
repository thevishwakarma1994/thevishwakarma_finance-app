import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { todayKolkata } from "../domain/calendar/kolkata.js";
import {
  buildFundingCycle,
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
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import { tables, anyDb, queryAll, queryRun } from "../db/exec.js";
import { withWorkspaceSalaryWriteLock } from "../db/salaryWriteLock.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import type { IsoDate } from "../domain/calendar/isoDate.js";

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
    const plan = planSalaryPolicyVersion(snapshot.incomePolicies, {
      expectedAmountPaise: paise(input.expectedAmountPaise),
      windowStartDay: input.windowStartDay,
      typicalDay: input.typicalDay,
      windowEndDay: input.windowEndDay,
      effectiveFrom,
    });

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

    const after = await loadSnapshot(tx, context.workspaceId, effectiveFrom);
    await syncExpectedFundingCycles(tx, context.workspaceId, after, effectiveFrom);
    return { policyId: plan.update?.id ?? plan.insert?.id ?? null };
  });
}

export async function salarySchedule(
  handles: DbHandles,
  context: WorkspaceContext,
  asOf = todayKolkata(),
) {
  const occurredOn = isoDate(asOf);
  await withWorkspaceSalaryWriteLock(handles, context.workspaceId, async (tx) => {
    const snapshot = await loadSnapshot(tx, context.workspaceId, occurredOn);
    await syncExpectedFundingCycles(tx, context.workspaceId, snapshot, occurredOn);
  });

  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  const policy = policyAsOf(snapshot.incomePolicies, occurredOn);
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
    nextExpected: next ? presentCycle(next, snapshot.incomePolicies) : null,
    receivableCycles: receivable.map((cycle) => presentCycle(cycle, snapshot.incomePolicies)),
  };
}

function presentCycle(cycle: ReturnType<typeof enrichFundingCycles>[number], policies: IncomePolicy[]) {
  const policy = policyAsOf(policies, cycle.expectedWindowStart);
  return {
    fundingCycleId: cycle.id,
    year: cycle.year,
    month: cycle.month,
    typicalOn: typicalOnForCycle(cycle, policy),
    windowStart: cycle.expectedWindowStart,
    windowEnd: cycle.expectedWindowEnd,
    expectedAmountPaise: cycle.expectedAmountSnapshot,
    status: cycle.status,
  };
}

async function syncExpectedFundingCycles(
  handles: DbHandles,
  workspaceId: string,
  snapshot: Awaited<ReturnType<typeof loadSnapshot>>,
  asOf: IsoDate,
) {
  const materialized = materializeFundingCycles(snapshot.incomePolicies, snapshot.fundingCycles, asOf);
  const existingByKey = new Map<string, FundingCycleRecord>(
    snapshot.fundingCycles.map((cycle) => [`${cycle.year}-${cycle.month}`, cycle]),
  );
  const toInsert: FundingCycleRecord[] = [];
  for (const cycle of materialized) {
    const key = `${cycle.year}-${cycle.month}`;
    if (!existingByKey.has(key)) {
      toInsert.push(cycle);
    }
  }
  if (toInsert.length > 0) {
    try {
      await persistBatch(handles, workspaceId, {
        events: [],
        postings: [],
        openings: [],
        fundingCycles: toInsert,
      });
    } catch (caught) {
      const err = caught as { message?: string; code?: string };
      if (!(err.message?.includes("UNIQUE") || err.code === "23505")) {
        throw err;
      }
    }
  }

  const t = tables(handles);
  const persisted = await queryAll<{
    id: string;
    year: number;
    month: number;
    expectedWindowStart: string;
    expectedWindowEnd: string;
    expectedAmountSnapshot: number;
    salaryEventId: string | null;
  }>(
    handles,
    anyDb(handles)
      .select({
        id: t.fundingCycles.id,
        year: t.fundingCycles.year,
        month: t.fundingCycles.month,
        expectedWindowStart: t.fundingCycles.expectedWindowStart,
        expectedWindowEnd: t.fundingCycles.expectedWindowEnd,
        expectedAmountSnapshot: t.fundingCycles.expectedAmountSnapshot,
        salaryEventId: t.fundingCycles.salaryEventId,
      })
      .from(t.fundingCycles)
      .where(and(eq(t.fundingCycles.workspaceId, workspaceId), isNull(t.fundingCycles.salaryEventId))),
  );

  for (const row of persisted) {
    const monthStart = isoDate(`${String(row.year).padStart(4, "0")}-${String(row.month).padStart(2, "0")}-01`);
    const policy = policyAsOf(snapshot.incomePolicies, monthStart);
    if (!policy) continue;
    const rebuilt = buildFundingCycle(policy, row.year, row.month);
    if (
      rebuilt.expectedWindowStart === row.expectedWindowStart &&
      rebuilt.expectedWindowEnd === row.expectedWindowEnd &&
      rebuilt.expectedAmountSnapshot === row.expectedAmountSnapshot
    ) {
      continue;
    }
    await queryRun(
      handles,
      anyDb(handles)
        .update(t.fundingCycles)
        .set({
          expectedWindowStart: rebuilt.expectedWindowStart,
          expectedWindowEnd: rebuilt.expectedWindowEnd,
          expectedAmountSnapshot: rebuilt.expectedAmountSnapshot,
        })
        .where(and(eq(t.fundingCycles.id, row.id), eq(t.fundingCycles.workspaceId, workspaceId))),
    );
  }
}
