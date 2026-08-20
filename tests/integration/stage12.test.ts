import { count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { evaluateSafeToSpend } from "../../src/domain/engine/evaluateSafeToSpend.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { home } from "../../src/db/reads.js";
import { financialEvents, fundingCycles, incomePolicies, postings } from "../../src/db/schema.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { recordIncome } from "../../src/app/recordIncome.js";
import { applySalaryPolicy, salarySchedule } from "../../src/app/salaryPolicy.js";
import { simulateAffordability } from "../../src/app/simulateAffordability.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

async function setup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  if (!hdfc) throw new Error("Expected seeded HDFC");
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfc.id,
    effectiveOn: "2026-08-01",
    balancePaise: 2_000_000,
    commit: true,
  });
  return { handles, workspaceId, hdfcId: hdfc.id };
}

describe("stage 12 home and salary persistence", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("does not seed an assumed income policy on migrate", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const n =
      ctx.handles.db
        .select({ value: count() })
        .from(incomePolicies)
        .where(eq(incomePolicies.workspaceId, ctx.workspaceId))
        .get()?.value ?? 0;
    expect(n).toBe(0);
  });

  it("Home STS works with no income policy and does not invent a salary window", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const asOf = isoDate("2026-09-10");
    const view = await home(ctx.handles, ctx.workspaceId, asOf);
    expect(view.incomePolicyConfigured).toBe(false);
    expect(view.salaryWindowStart).toBeNull();
    expect(view.expectedSalaryPaise).toBe(0);
    expect(view.currentCycleSafeToSpend).toBe(2_000_000);
    expect(view.riskFlags).toContain("salary_schedule_not_configured");
    expect(view.explanationItems.some((item) => item.label === "Salary schedule not configured")).toBe(
      true,
    );
  });

  it("U — simulation creates no DB/event/posting writes", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      commit: true,
    });
    const eventsBefore =
      ctx.handles.db.select({ value: count() }).from(financialEvents).where(eq(financialEvents.workspaceId, ctx.workspaceId)).get()?.value ?? 0;
    const postingsBefore =
      ctx.handles.db.select({ value: count() }).from(postings).where(eq(postings.workspaceId, ctx.workspaceId)).get()?.value ?? 0;
    await simulateAffordability(ctx.handles, { workspaceId: ctx.workspaceId }, {
      amountPaise: 50_000,
      occurredOn: "2026-08-20",
      funding: { accountId: ctx.hdfcId },
    });
    const eventsAfter =
      ctx.handles.db.select({ value: count() }).from(financialEvents).where(eq(financialEvents.workspaceId, ctx.workspaceId)).get()?.value ?? 0;
    const postingsAfter =
      ctx.handles.db.select({ value: count() }).from(postings).where(eq(postings.workspaceId, ctx.workspaceId)).get()?.value ?? 0;
    expect(eventsAfter).toBe(eventsBefore);
    expect(postingsAfter).toBe(postingsBefore);
  });

  it("V — Home read model uses the same engine result as the domain snapshot", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      commit: true,
    });
    const asOf = isoDate("2026-08-20");
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, asOf);
    const engine = evaluateSafeToSpend(snapshot, asOf);
    const view = await home(ctx.handles, ctx.workspaceId, asOf);
    expect(view.currentCycleSafeToSpend).toBe(engine.currentCycleSafeToSpend);
    expect(view.availableLiquid).toBe(engine.availableLiquid);
    expect(view.riskFlags).toEqual(engine.riskFlags);
  });

  it("salary recording sets FundingCycle actuals without duplicating", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, {
      expectedAmountPaise: 7_920_000,
      windowStartDay: 4,
      typicalDay: 5,
      windowEndDay: 8,
      effectiveFrom: "2020-01-01",
    });
    const schedule = await salarySchedule(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      isoDate("2026-08-05"),
    );
    const cycleId =
      schedule.receivableCycles.find((cycle) => cycle.year === 2026 && cycle.month === 8)?.fundingCycleId ??
      schedule.nextExpected?.fundingCycleId;
    expect(cycleId).toBeTruthy();
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      fundingCycleId: cycleId,
      commit: true,
    });
    const cycle = ctx.handles.db.select().from(fundingCycles).where(eq(fundingCycles.workspaceId, ctx.workspaceId)).all()
      .find((row) => row.id === cycleId);
    expect(cycle?.actualArrivalOn).toBe("2026-08-05");
    expect(cycle?.actualAmountPaise).toBe(7_920_000);
    expect(cycle?.year).toBe(2026);
    expect(cycle?.month).toBe(8);
    await expect(
      recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-06",
        capturedAt,
        accountId: ctx.hdfcId,
        amountPaise: 7_920_000,
        kind: "salary",
        fundingCycleId: cycleId,
        commit: true,
      }),
    ).rejects.toThrow(/already has a salary/);
  });

  it("salary without a policy still records income and does not fabricate a funding cycle", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.fundingCycles).toHaveLength(0);
    expect(snapshot.events.some((event) => event.meaning === "income")).toBe(true);
    const hdfc = snapshot.accounts.find((account) => account.id === ctx.hdfcId);
    expect(hdfc?.balancePaise).toBe(9_920_000);
  });
});
