import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { utcNowIso } from "../../src/domain/calendar/kolkata.js";
import { newId } from "../../src/domain/ids.js";
import { evaluateSafeToSpend } from "../../src/domain/engine/evaluateSafeToSpend.js";
import {
  closeDatabase,
  openMemoryDatabase,
  type SqliteHandles,
} from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId, LEGACY_WORKSPACE_NAME } from "../../src/db/migrate.js";
import { applyPostgresMigrations, truncatePostgresData } from "../../src/db/pg/migrate.js";
import { openPostgresDatabase } from "../../src/db/pg/client.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { anyDb, tables } from "../../src/db/exec.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { recordIncome } from "../../src/app/recordIncome.js";
import { applySalaryPolicy, salarySchedule } from "../../src/app/salaryPolicy.js";
import { simulateAffordability } from "../../src/app/simulateAffordability.js";

const capturedAt = "2026-08-16T10:00:00.000Z";
const postgresUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const describePg = postgresUrl ? describe : describe.skip;
const pgTimeoutMs = 120_000;

const POLICY = {
  expectedAmountPaise: 7_920_000,
  windowStartDay: 4,
  typicalDay: 5,
  windowEndDay: 8,
  effectiveFrom: "2026-08-01",
};

function isDomain(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}

async function seedSqlite() {
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

async function cycleId(
  handles: Parameters<typeof salarySchedule>[0],
  workspaceId: string,
  asOf: string,
  year: number,
  month: number,
) {
  const schedule = await salarySchedule(handles, { workspaceId }, isoDate(asOf));
  const match =
    schedule.receivableCycles.find((cycle) => cycle.year === year && cycle.month === month) ??
    (schedule.nextExpected?.year === year && schedule.nextExpected.month === month
      ? schedule.nextExpected
      : null);
  if (!match) throw new Error(`Missing funding cycle ${year}-${month} as of ${asOf}`);
  return match.fundingCycleId;
}

describe("phase 16b salary receipt", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("records actual ₹80,200 against expected ₹79,200 without rewriting the event date", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, POLICY);
    const fundingCycleId = await cycleId(ctx.handles, ctx.workspaceId, "2026-08-05", 2026, 8);
    const result = await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-salary-aug",
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 8_020_000,
      kind: "salary",
      fundingCycleId,
      commit: true,
    });
    expect(result.eventId).toBe("cmd-salary-aug");
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-05"));
    expect(snapshot.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise).toBe(10_020_000);
    expect(snapshot.postings.filter((posting) => posting.pnl === "income_salary").reduce((sum, posting) => sum + posting.amountPaise, 0)).toBe(8_020_000);
    const cycle = snapshot.fundingCycles.find((item) => item.id === fundingCycleId);
    expect(cycle?.actualAmountPaise).toBe(8_020_000);
    expect(cycle?.actualArrivalOn).toBe("2026-08-05");
    expect(cycle?.salaryEventId).toBe("cmd-salary-aug");
    expect(snapshot.events.filter((event) => event.meaning === "income")).toHaveLength(1);
  });

  it("supports an early receipt before the window opens", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, POLICY);
    const fundingCycleId = await cycleId(ctx.handles, ctx.workspaceId, "2026-08-01", 2026, 8);
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      fundingCycleId,
      commit: true,
    });
    const early = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-01"));
    expect(early.fundingCycles.find((cycle) => cycle.id === fundingCycleId)?.actualArrivalOn).toBe("2026-08-01");
  });

  it("supports an on-time receipt on the typical day", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, POLICY);
    const fundingCycleId = await cycleId(ctx.handles, ctx.workspaceId, "2026-08-05", 2026, 8);
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      fundingCycleId,
      commit: true,
    });
    const onTime = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-05"));
    expect(onTime.fundingCycles.find((cycle) => cycle.id === fundingCycleId)?.actualArrivalOn).toBe("2026-08-05");
  });

  it("supports a late same-month receipt after the window closes", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, POLICY);
    const fundingCycleId = await cycleId(ctx.handles, ctx.workspaceId, "2026-08-20", 2026, 8);
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      fundingCycleId,
      commit: true,
    });
    const late = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-20"));
    expect(late.fundingCycles.find((cycle) => cycle.id === fundingCycleId)?.actualArrivalOn).toBe("2026-08-20");
  });

  it("keeps a late cross-month receipt on the selected September cycle", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, POLICY);
    const septemberId = await cycleId(ctx.handles, ctx.workspaceId, "2026-09-05", 2026, 9);
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-sep-late",
      occurredOn: "2026-10-02",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      fundingCycleId: septemberId,
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-10-02"));
    const event = snapshot.events.find((item) => item.id === "cmd-sep-late");
    expect(event?.occurredOn).toBe("2026-10-02");
    const september = snapshot.fundingCycles.find((cycle) => cycle.id === septemberId);
    expect(september?.year).toBe(2026);
    expect(september?.month).toBe(9);
    expect(september?.actualArrivalOn).toBe("2026-10-02");
    expect(september?.salaryEventId).toBe("cmd-sep-late");
  });

  it("still records ordinary salary when no schedule exists", async () => {
    const ctx = await seedSqlite();
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
    expect(snapshot.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise).toBe(9_920_000);
  });

  it("rejects a second receipt for the same funding cycle", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, POLICY);
    const fundingCycleId = await cycleId(ctx.handles, ctx.workspaceId, "2026-08-05", 2026, 8);
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      fundingCycleId,
      commit: true,
    });
    await expect(
      recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-06",
        capturedAt,
        accountId: ctx.hdfcId,
        amountPaise: 7_920_000,
        kind: "salary",
        fundingCycleId,
        commit: true,
      }),
    ).rejects.toSatisfy((error) => isDomain(error, "already_received"));
  });

  it("replays the same salary commandId and conflicts on a changed payload", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, POLICY);
    const fundingCycleId = await cycleId(ctx.handles, ctx.workspaceId, "2026-08-05", 2026, 8);
    const payload = {
      commandId: "cmd-salary-idem",
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 8_020_000,
      kind: "salary" as const,
      fundingCycleId,
      commit: true,
    };
    const first = await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, payload);
    const second = await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, payload);
    expect(first.eventId).toBe("cmd-salary-idem");
    expect(second.eventId).toBe("cmd-salary-idem");
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-05"));
    expect(snapshot.events.filter((event) => event.meaning === "income")).toHaveLength(1);

    await expect(recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, { ...payload, amountPaise: 7_920_000 })).rejects.toSatisfy(
      (error) => isDomain(error, "idempotency_conflict"),
    );
    await expect(recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, { ...payload, occurredOn: "2026-08-06" })).rejects.toSatisfy(
      (error) => isDomain(error, "idempotency_conflict"),
    );
    await expect(recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, { ...payload, fundingCycleId: undefined })).rejects.toSatisfy(
      (error) => isDomain(error, "idempotency_conflict"),
    );
  });

  it("does not treat expected salary as liquid cash or current STS", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    const beforeSnap = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-05"));
    const before = evaluateSafeToSpend(beforeSnap, isoDate("2026-08-05"));
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, POLICY);
    const afterSnap = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-05"));
    const after = evaluateSafeToSpend(afterSnap, isoDate("2026-08-05"));
    expect(after.liquidTotal).toBe(before.liquidTotal);
    expect(after.availableLiquid).toBe(before.availableLiquid);
    expect(after.currentCycleSafeToSpend).toBe(before.currentCycleSafeToSpend);
    expect(after.incomePolicyConfigured).toBe(true);
    expect(after.nextExpectedIncomeWindow.expectedAmount).toBe(7_920_000);

    const afford = await simulateAffordability(ctx.handles, { workspaceId: ctx.workspaceId }, {
      amountPaise: 1_000,
      occurredOn: "2026-08-20",
      funding: { accountId: ctx.hdfcId },
    });
    const upcoming = afford.cycleProjections.find((cycle: { month: number; expectedIncome: number }) => cycle.month === 9);
    expect(upcoming?.expectedIncome).toBe(7_920_000);
  });

  it("uses existing delayed-window projection rules until an actual receipt arrives", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, POLICY);
    const delayedSnap = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-09-10"));
    const delayed = evaluateSafeToSpend(delayedSnap, isoDate("2026-09-10"));
    expect(delayed.riskFlags).toContain("expected_income_delayed");
    const afford = await simulateAffordability(ctx.handles, { workspaceId: ctx.workspaceId }, {
      amountPaise: 1_000,
      occurredOn: "2026-09-10",
      funding: { accountId: ctx.hdfcId },
    });
    const september = afford.cycleProjections.find((cycle: { month: number; expectedIncome: number }) => cycle.month === 9);
    expect(september?.expectedIncome).toBe(0);

    const septemberId = delayed.fundingCycles.find((cycle) => cycle.year === 2026 && cycle.month === 9)!.id;
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-12",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      fundingCycleId: septemberId,
      commit: true,
    });
    const received = evaluateSafeToSpend(
      await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-09-12")),
      isoDate("2026-09-12"),
    );
    expect(received.liquidTotal).toBe(2_000_000 + 7_920_000);
    expect(received.availableLiquid).toBe(2_000_000 + 7_920_000);
    expect(received.currentCycleSafeToSpend).toBe(2_000_000 + 7_920_000);
  });
});

describePg("phase 16b salary receipt (postgres)", { timeout: pgTimeoutMs }, () => {
  let handles: ReturnType<typeof openPostgresDatabase> | undefined;

  afterEach(async () => {
    if (!handles) return;
    await truncatePostgresData(handles);
    await closeDatabase(handles);
    handles = undefined;
  });

  async function setupPg() {
    handles = openPostgresDatabase(postgresUrl);
    await applyPostgresMigrations(handles);
    await truncatePostgresData(handles);
    const workspaceId = newId();
    const hdfcId = newId();
    const now = utcNowIso();
    const t = tables(handles);
    const db = anyDb(handles);
    await db.insert(t.workspaces).values({ id: workspaceId, name: LEGACY_WORKSPACE_NAME, createdAt: now });
    await db.insert(t.accounts).values({
      id: hdfcId,
      workspaceId,
      kind: "bank",
      displayName: "HDFC",
      mask: "2581",
      isPrimarySalary: 1,
      status: "active",
      createdAt: now,
    });
    await applyOpening(handles, { workspaceId }, {
      accountId: hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 2_000_000,
      commit: true,
    });
    return { workspaceId, hdfcId };
  }

  it("links a late cross-month receipt and replays the same commandId", async () => {
    const ctx = await setupPg();
    await applySalaryPolicy(handles!, { workspaceId: ctx.workspaceId }, POLICY);
    const fundingCycleId = await cycleId(handles!, ctx.workspaceId, "2026-09-05", 2026, 9);
    const payload = {
      commandId: "cmd-pg-sep-late",
      occurredOn: "2026-10-02",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 8_020_000,
      kind: "salary" as const,
      fundingCycleId,
      commit: true,
    };
    await recordIncome(handles!, { workspaceId: ctx.workspaceId }, payload);
    await recordIncome(handles!, { workspaceId: ctx.workspaceId }, payload);
    const snapshot = await loadSnapshot(handles!, ctx.workspaceId, isoDate("2026-10-02"));
    expect(snapshot.events.filter((event) => event.meaning === "income")).toHaveLength(1);
    const cycle = snapshot.fundingCycles.find((item) => item.id === fundingCycleId);
    expect(cycle?.month).toBe(9);
    expect(cycle?.actualArrivalOn).toBe("2026-10-02");
    expect(cycle?.actualAmountPaise).toBe(8_020_000);
    await expect(
      recordIncome(handles!, { workspaceId: ctx.workspaceId }, { ...payload, amountPaise: 7_920_000 }),
    ).rejects.toSatisfy((error) => isDomain(error, "idempotency_conflict"));
  });
});
