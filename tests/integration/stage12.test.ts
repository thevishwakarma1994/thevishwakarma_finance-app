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
import { simulateAffordability } from "../../src/app/simulateAffordability.js";
import { newId } from "../../src/domain/ids.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

function setup() {
  const handles = openMemoryDatabase();
  applyMigrations(handles);
  const workspaceId = getSoleWorkspaceId(handles);
  const snapshot = loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  if (!hdfc) throw new Error("Expected seeded HDFC");
  applyOpening(handles, { workspaceId }, {
    accountId: hdfc.id,
    effectiveOn: "2026-08-01",
    balancePaise: 2_000_000,
    commit: true,
  });
  return { handles, workspaceId, hdfcId: hdfc.id };
}

function insertScenarioIncomePolicy(handles: SqliteHandles, workspaceId: string): void {
  handles.db
    .insert(incomePolicies)
    .values({
      id: newId(),
      workspaceId,
      expectedAmountPaise: 7_920_000,
      windowStartDay: 4,
      windowEndDay: 8,
      typicalDay: 5,
      effectiveFrom: "2020-01-01",
      effectiveTo: null,
    })
    .run();
}

describe("stage 12 home and salary persistence", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("does not seed an assumed income policy on migrate", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    const n =
      ctx.handles.db
        .select({ value: count() })
        .from(incomePolicies)
        .where(eq(incomePolicies.workspaceId, ctx.workspaceId))
        .get()?.value ?? 0;
    expect(n).toBe(0);
  });

  it("Home STS works with no income policy and does not invent a salary window", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    const asOf = isoDate("2026-09-10");
    const view = home(ctx.handles, ctx.workspaceId, asOf);
    expect(view.incomePolicyConfigured).toBe(false);
    expect(view.salaryWindowStart).toBeNull();
    expect(view.expectedSalaryPaise).toBe(0);
    expect(view.currentCycleSafeToSpend).toBe(2_000_000);
    expect(view.riskFlags).toContain("salary_schedule_not_configured");
    expect(view.explanationItems.some((item) => item.label === "Salary schedule not configured")).toBe(
      true,
    );
  });

  it("U — simulation creates no DB/event/posting writes", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
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
    simulateAffordability(ctx.handles, { workspaceId: ctx.workspaceId }, {
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

  it("V — Home read model uses the same engine result as the domain snapshot", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      commit: true,
    });
    const asOf = isoDate("2026-08-20");
    const snapshot = loadSnapshot(ctx.handles, ctx.workspaceId, asOf);
    const engine = evaluateSafeToSpend(snapshot, asOf);
    const view = home(ctx.handles, ctx.workspaceId, asOf);
    expect(view.currentCycleSafeToSpend).toBe(engine.currentCycleSafeToSpend);
    expect(view.availableLiquid).toBe(engine.availableLiquid);
    expect(view.riskFlags).toEqual(engine.riskFlags);
  });

  it("salary recording sets FundingCycle actuals without duplicating", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    insertScenarioIncomePolicy(ctx.handles, ctx.workspaceId);
    recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      commit: true,
    });
    const cycle = ctx.handles.db.select().from(fundingCycles).where(eq(fundingCycles.workspaceId, ctx.workspaceId)).get();
    expect(cycle?.actualArrivalOn).toBe("2026-08-05");
    expect(cycle?.actualAmountPaise).toBe(7_920_000);
    expect(cycle?.year).toBe(2026);
    expect(cycle?.month).toBe(8);
    expect(() =>
      recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-06",
        capturedAt,
        accountId: ctx.hdfcId,
        amountPaise: 7_920_000,
        kind: "salary",
        commit: true,
      }),
    ).toThrow(/already has a salary/);
  });

  it("salary without a policy still records income and does not fabricate a funding cycle", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      commit: true,
    });
    const snapshot = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.fundingCycles).toHaveLength(0);
    expect(snapshot.events.some((event) => event.meaning === "income")).toBe(true);
    const hdfc = snapshot.accounts.find((account) => account.id === ctx.hdfcId);
    expect(hdfc?.balancePaise).toBe(9_920_000);
  });
});
