import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { utcNowIso } from "../../src/domain/calendar/kolkata.js";
import { newId } from "../../src/domain/ids.js";
import { openMemoryDatabase, closeDatabase, type DbHandles, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId, LEGACY_WORKSPACE_NAME } from "../../src/db/migrate.js";
import { applyPostgresMigrations, truncatePostgresData } from "../../src/db/pg/migrate.js";
import { openPostgresDatabase } from "../../src/db/pg/client.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { anyDb, queryAll, tables } from "../../src/db/exec.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { applySalaryPolicy, ensureExpectedFundingCycle, salarySchedule } from "../../src/app/salaryPolicy.js";
import { recordIncome } from "../../src/app/recordIncome.js";
import { policyAsOf } from "../../src/domain/funding/cycles.js";

const postgresUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const describePg = postgresUrl ? describe : describe.skip;
const pgTimeoutMs = 120_000;

const AUG = {
  expectedAmountPaise: 7_920_000,
  windowStartDay: 4,
  typicalDay: 5,
  windowEndDay: 8,
  effectiveFrom: "2026-08-01",
};

function isDomain(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}

function assertNoPolicyOverlap(policies: { effectiveFrom: string; effectiveTo: string | null }[]) {
  const sorted = [...policies].sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const currentEnd = sorted[index]!.effectiveTo ?? "9999-12-31";
    expect(currentEnd < sorted[index + 1]!.effectiveFrom).toBe(true);
  }
}

async function seedSqlite() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  if (!hdfc) throw new Error("Expected seeded HDFC");
  return { handles, workspaceId, hdfcId: hdfc.id };
}

async function seedPostgresWorkspace(handles: DbHandles) {
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
  await db.insert(t.categories).values({
    id: newId(),
    workspaceId,
    parentId: null,
    name: "Grocery",
    archivedAt: null,
  });
  return { workspaceId, hdfcId };
}

async function cycleFor(
  handles: DbHandles,
  workspaceId: string,
  asOf: string,
  year: number,
  month: number,
) {
  const schedule = await salarySchedule(handles, { workspaceId }, isoDate(asOf));
  return schedule.receivableCycles.find((cycle) => cycle.year === year && cycle.month === month) ??
    (schedule.nextExpected?.year === year && schedule.nextExpected.month === month
      ? schedule.nextExpected
      : null);
}

async function fundingRows(handles: DbHandles, workspaceId: string) {
  const t = tables(handles);
  const rows = await queryAll<{
    id: string;
    year: number;
    month: number;
    expectedWindowStart: string;
    expectedWindowEnd: string;
    expectedAmountSnapshot: number;
    actualArrivalOn: string | null;
    actualAmountPaise: number | null;
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
        actualArrivalOn: t.fundingCycles.actualArrivalOn,
        actualAmountPaise: t.fundingCycles.actualAmountPaise,
        salaryEventId: t.fundingCycles.salaryEventId,
      })
      .from(t.fundingCycles)
      .where(eq(t.fundingCycles.workspaceId, workspaceId)),
  );
  return [...rows].sort((left, right) => left.year - right.year || left.month - right.month || left.id.localeCompare(right.id));
}

describe("phase 16b salary policy", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("creates the first 4/5/8 salary schedule", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    const result = await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, AUG);
    expect(result.policyId).toBeTruthy();
    const schedule = await salarySchedule(ctx.handles, { workspaceId: ctx.workspaceId }, isoDate("2026-08-05"));
    expect(schedule.policy).toMatchObject({
      expectedAmountPaise: 7_920_000,
      windowStartDay: 4,
      typicalDay: 5,
      windowEndDay: 8,
      effectiveFrom: "2026-08-01",
    });
    expect(schedule.primarySalaryAccount?.displayName).toBe("HDFC");
    expect(schedule.nextExpected?.typicalOn).toBe("2026-08-05");
    expect(schedule.nextExpected?.status).toBe("window_open_unreceived");
  });

  it("rejects an invalid arrival window", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await expect(
      applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, {
        ...AUG,
        windowStartDay: 8,
        typicalDay: 5,
        windowEndDay: 4,
      }),
    ).rejects.toSatisfy((error) => isDomain(error, "invalid_salary_schedule"));
  });

  it("allows a same-effectiveFrom edit before any dependent cycle exists", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, AUG);
    const before = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-05"));
    expect(before.fundingCycles).toHaveLength(0);

    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, {
      ...AUG,
      expectedAmountPaise: 8_200_000,
    });
    const schedule = await salarySchedule(ctx.handles, { workspaceId: ctx.workspaceId }, isoDate("2026-08-05"));
    expect(schedule.policy?.expectedAmountPaise).toBe(8_200_000);
    expect((await loadSnapshot(ctx.handles, ctx.workspaceId)).fundingCycles).toHaveLength(0);
  });

  it("rejects a same-effectiveFrom edit after one unreceived cycle exists", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, AUG);
    await ensureExpectedFundingCycle(ctx.handles, ctx.workspaceId, 2026, 8);
    const before = await fundingRows(ctx.handles, ctx.workspaceId);
    expect(before).toHaveLength(1);

    await expect(
      applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, {
        ...AUG,
        expectedAmountPaise: 8_200_000,
      }),
    ).rejects.toSatisfy((error) => isDomain(error, "policy_version_in_use"));
    expect(await fundingRows(ctx.handles, ctx.workspaceId)).toEqual(before);
  });

  it("rejects a same-effectiveFrom edit after a received cycle exists", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      accountId: ctx.hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 2_000_000,
      commit: true,
    });
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, AUG);
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt: "2026-08-05T04:30:00.000Z",
      accountId: ctx.hdfcId,
      amountPaise: 7_920_000,
      kind: "salary",
      expectedYear: 2026,
      expectedMonth: 8,
      commit: true,
    });
    const before = await fundingRows(ctx.handles, ctx.workspaceId);
    expect(before).toHaveLength(1);
    expect(before[0]?.salaryEventId).toBeTruthy();

    await expect(
      applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, {
        ...AUG,
        expectedAmountPaise: 8_200_000,
      }),
    ).rejects.toSatisfy((error) => isDomain(error, "policy_version_in_use"));
    expect(await fundingRows(ctx.handles, ctx.workspaceId)).toEqual(before);
  });

  it("rejects a same-effectiveFrom edit after several unreceived cycles exist and preserves snapshots", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, AUG);
    await ensureExpectedFundingCycle(ctx.handles, ctx.workspaceId, 2026, 8);
    await ensureExpectedFundingCycle(ctx.handles, ctx.workspaceId, 2026, 9);
    await ensureExpectedFundingCycle(ctx.handles, ctx.workspaceId, 2026, 10);
    const before = await fundingRows(ctx.handles, ctx.workspaceId);
    expect(before).toHaveLength(3);

    await expect(
      applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, {
        ...AUG,
        expectedAmountPaise: 8_200_000,
      }),
    ).rejects.toSatisfy((error) => isDomain(error, "policy_version_in_use"));
    expect(await fundingRows(ctx.handles, ctx.workspaceId)).toEqual(before);
    expect(before.every((row) => row.expectedAmountSnapshot === 7_920_000)).toBe(true);
  });

  it("versions a later expected amount without rewriting the old cycle snapshot", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, AUG);
    await ensureExpectedFundingCycle(ctx.handles, ctx.workspaceId, 2026, 8);
    const beforeAugust = (await fundingRows(ctx.handles, ctx.workspaceId)).find(
      (row) => row.year === 2026 && row.month === 8,
    );
    expect(beforeAugust?.expectedAmountSnapshot).toBe(7_920_000);

    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, {
      expectedAmountPaise: 8_200_000,
      windowStartDay: 4,
      typicalDay: 5,
      windowEndDay: 8,
      effectiveFrom: "2027-01-01",
    });

    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2027-01-05"));
    assertNoPolicyOverlap(snapshot.incomePolicies);
    expect(policyAsOf(snapshot.incomePolicies, isoDate("2026-08-05"))?.expectedAmountPaise).toBe(7_920_000);
    expect(policyAsOf(snapshot.incomePolicies, isoDate("2027-01-05"))?.expectedAmountPaise).toBe(8_200_000);

    const stillAugust = snapshot.fundingCycles.find((cycle) => cycle.year === 2026 && cycle.month === 8);
    expect(stillAugust).toEqual({
      id: beforeAugust!.id,
      year: 2026,
      month: 8,
      expectedWindowStart: beforeAugust!.expectedWindowStart,
      expectedWindowEnd: beforeAugust!.expectedWindowEnd,
      expectedAmountSnapshot: 7_920_000,
      actualArrivalOn: null,
      actualAmountPaise: null,
      salaryEventId: null,
    });
    const january = await cycleFor(ctx.handles, ctx.workspaceId, "2027-01-05", 2027, 1);
    expect(january?.expectedAmountPaise).toBe(8_200_000);
  });

  it("uses the next eligible month when effectiveFrom is mid-month", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, {
      ...AUG,
      effectiveFrom: "2026-08-05",
    });
    const during = await salarySchedule(ctx.handles, { workspaceId: ctx.workspaceId }, isoDate("2026-08-05"));
    expect(during.receivableCycles.some((cycle) => cycle.year === 2026 && cycle.month === 8)).toBe(false);
    expect(during.receivableCycles.some((cycle) => cycle.year === 2026 && cycle.month === 9)).toBe(true);

    const ctx2 = await seedSqlite();
    contexts.push(ctx2.handles);
    await applySalaryPolicy(ctx2.handles, { workspaceId: ctx2.workspaceId }, {
      ...AUG,
      effectiveFrom: "2026-08-10",
    });
    const after = await salarySchedule(ctx2.handles, { workspaceId: ctx2.workspaceId }, isoDate("2026-08-10"));
    expect(after.receivableCycles.some((cycle) => cycle.year === 2026 && cycle.month === 8)).toBe(false);
    expect(after.nextExpected?.month).toBe(9);
  });

  it("rejects cross-workspace use of another workspace's funding cycle", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    const ws2 = newId();
    const acc2 = newId();
    ctx.handles.sqlite
      .prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, '2026-08-01')")
      .run(ws2, "Other");
    ctx.handles.sqlite
      .prepare(
        "INSERT INTO accounts (id, workspace_id, kind, display_name, status, created_at) VALUES (?, ?, 'bank', 'SBI', 'active', '2026-08-01')",
      )
      .run(acc2, ws2);

    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, AUG);
    const persisted = await ensureExpectedFundingCycle(ctx.handles, ctx.workspaceId, 2026, 8);
    const otherSchedule = await salarySchedule(ctx.handles, { workspaceId: ws2 }, isoDate("2026-08-05"));
    expect(otherSchedule.policy).toBeNull();
    expect(otherSchedule.receivableCycles).toHaveLength(0);

    await applyOpening(ctx.handles, { workspaceId: ws2 }, {
      accountId: acc2,
      effectiveOn: "2026-08-01",
      balancePaise: 1_000_000,
      commit: true,
    });
    await expect(
      recordIncome(ctx.handles, { workspaceId: ws2 }, {
        occurredOn: "2026-08-05",
        capturedAt: "2026-08-05T04:30:00.000Z",
        accountId: acc2,
        amountPaise: 7_920_000,
        kind: "salary",
        fundingCycleId: persisted.id,
        commit: true,
      }),
    ).rejects.toSatisfy((error) => isDomain(error, "cycle_not_found"));
  });

  it("policy creation produces no cash, income, or financial events", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    const before = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-01"));
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, AUG);
    const after = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-05"));
    expect(after.events).toHaveLength(before.events.length);
    expect(after.postings.filter((posting) => posting.pnl?.startsWith("income_"))).toHaveLength(0);
    expect(after.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise).toBe(
      before.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise,
    );
  });
});

describePg("phase 16b salary policy (postgres)", { timeout: pgTimeoutMs }, () => {
  let handles: ReturnType<typeof openPostgresDatabase> | undefined;

  afterEach(async () => {
    if (!handles) return;
    await truncatePostgresData(handles);
    await closeDatabase(handles);
    handles = undefined;
  });

  it("versions expected salary without overlapping active policies", async () => {
    handles = openPostgresDatabase(postgresUrl);
    await applyPostgresMigrations(handles);
    await truncatePostgresData(handles);
    const seeded = await seedPostgresWorkspace(handles);
    await applySalaryPolicy(handles, { workspaceId: seeded.workspaceId }, AUG);
    await applySalaryPolicy(handles, { workspaceId: seeded.workspaceId }, {
      expectedAmountPaise: 8_200_000,
      windowStartDay: 4,
      typicalDay: 5,
      windowEndDay: 8,
      effectiveFrom: "2027-01-01",
    });
    const snapshot = await loadSnapshot(handles, seeded.workspaceId, isoDate("2027-01-05"));
    assertNoPolicyOverlap(snapshot.incomePolicies);
    expect(policyAsOf(snapshot.incomePolicies, isoDate("2026-08-05"))?.expectedAmountPaise).toBe(7_920_000);
    expect(policyAsOf(snapshot.incomePolicies, isoDate("2027-01-05"))?.expectedAmountPaise).toBe(8_200_000);
  });
});
