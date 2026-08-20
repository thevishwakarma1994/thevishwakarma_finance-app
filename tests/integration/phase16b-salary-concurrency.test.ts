import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { utcNowIso } from "../../src/domain/calendar/kolkata.js";
import { newId } from "../../src/domain/ids.js";
import { policyAsOf } from "../../src/domain/funding/cycles.js";
import {
  closeDatabase,
  openDatabase,
  type DbHandles,
  type SqliteHandles,
} from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId, LEGACY_WORKSPACE_NAME } from "../../src/db/migrate.js";
import { applyPostgresMigrations, truncatePostgresData } from "../../src/db/pg/migrate.js";
import { openPostgresDatabase } from "../../src/db/pg/client.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { anyDb, tables } from "../../src/db/exec.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { recordIncome } from "../../src/app/recordIncome.js";
import { applySalaryPolicy, ensureExpectedFundingCycle, salarySchedule } from "../../src/app/salaryPolicy.js";

const capturedAt = "2026-08-16T10:00:00.000Z";
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

async function seedOpening(handles: DbHandles) {
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
  return { workspaceId, hdfcId: hdfc.id };
}

describe("phase 16b salary concurrency (sqlite two connections)", () => {
  const cleanup: Array<{ handles: SqliteHandles[]; dir: string }> = [];

  afterEach(() => {
    for (const item of cleanup.splice(0)) {
      for (const handles of item.handles) handles.sqlite.close();
      fs.rmSync(item.dir, { recursive: true, force: true });
    }
  });

  async function dualSqlite() {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "tmp-salary-lock-"));
    const dbPath = path.join(dir, "ledger.sqlite");
    const a = openDatabase(dbPath);
    await applyMigrations(a);
    const b = openDatabase(dbPath);
    cleanup.push({ handles: [a, b], dir });
    const seeded = await seedOpening(a);
    return { a, b, ...seeded };
  }

  it("allows only one salary receipt for the same funding cycle", async () => {
    const ctx = await dualSqlite();
    await applySalaryPolicy(ctx.a, { workspaceId: ctx.workspaceId }, AUG);
    const results = await Promise.allSettled([
      recordIncome(ctx.a, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-salary-a",
        occurredOn: "2026-08-05",
        capturedAt,
        accountId: ctx.hdfcId,
        amountPaise: 8_020_000,
        kind: "salary",
        expectedYear: 2026,
        expectedMonth: 8,
        commit: true,
      }),
      recordIncome(ctx.b, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-salary-b",
        occurredOn: "2026-08-05",
        capturedAt,
        accountId: ctx.hdfcId,
        amountPaise: 7_920_000,
        kind: "salary",
        expectedYear: 2026,
        expectedMonth: 8,
        commit: true,
      }),
    ]);
    const wins = results.filter((result) => result.status === "fulfilled");
    const losses = results.filter((result) => result.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(isDomain((losses[0] as PromiseRejectedResult).reason, "already_received")).toBe(true);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId, isoDate("2026-08-05"));
    expect(snapshot.events.filter((event) => event.meaning === "income")).toHaveLength(1);
    const cycle = snapshot.fundingCycles.find((item) => item.year === 2026 && item.month === 8);
    expect(cycle?.salaryEventId).toBeTruthy();
  });

  it("keeps salary policy versions from overlapping when two changes race", async () => {
    const ctx = await dualSqlite();
    const results = await Promise.allSettled([
      applySalaryPolicy(ctx.a, { workspaceId: ctx.workspaceId }, AUG),
      applySalaryPolicy(ctx.b, { workspaceId: ctx.workspaceId }, {
        expectedAmountPaise: 8_200_000,
        windowStartDay: 4,
        typicalDay: 5,
        windowEndDay: 8,
        effectiveFrom: "2027-01-01",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId, isoDate("2027-01-05"));
    assertNoPolicyOverlap(snapshot.incomePolicies);
    const august = policyAsOf(snapshot.incomePolicies, isoDate("2026-08-05"));
    const january = policyAsOf(snapshot.incomePolicies, isoDate("2027-01-05"));
    expect(august).toBeTruthy();
    expect(january).toBeTruthy();
    if (august && january && august.id !== january.id) {
      expect(august.expectedAmountPaise).toBe(7_920_000);
      expect(january.expectedAmountPaise).toBe(8_200_000);
    }
  });

  it("rejects competing same-effectiveFrom edits after a dependent cycle exists", async () => {
    const ctx = await dualSqlite();
    await applySalaryPolicy(ctx.a, { workspaceId: ctx.workspaceId }, AUG);
    await ensureExpectedFundingCycle(ctx.a, ctx.workspaceId, 2026, 8);
    const results = await Promise.allSettled([
      applySalaryPolicy(ctx.a, { workspaceId: ctx.workspaceId }, { ...AUG, expectedAmountPaise: 8_200_000 }),
      applySalaryPolicy(ctx.b, { workspaceId: ctx.workspaceId }, { ...AUG, expectedAmountPaise: 8_500_000 }),
    ]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect(
      results
        .filter((result) => result.status === "rejected")
        .every((result) => isDomain((result as PromiseRejectedResult).reason, "policy_version_in_use")),
    ).toBe(true);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId, isoDate("2026-08-05"));
    expect(snapshot.incomePolicies).toHaveLength(1);
    expect(snapshot.incomePolicies[0]?.expectedAmountPaise).toBe(7_920_000);
    expect(snapshot.fundingCycles.find((cycle) => cycle.month === 8)?.expectedAmountSnapshot).toBe(7_920_000);
  });

  it("keeps GET reads consistent with a concurrent receipt materialize", async () => {
    const ctx = await dualSqlite();
    await applySalaryPolicy(ctx.a, { workspaceId: ctx.workspaceId }, AUG);
    const results = await Promise.allSettled([
      salarySchedule(ctx.a, { workspaceId: ctx.workspaceId }, isoDate("2026-08-05")),
      salarySchedule(ctx.b, { workspaceId: ctx.workspaceId }, isoDate("2026-10-02")),
      recordIncome(ctx.a, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-read-race",
        occurredOn: "2026-08-05",
        capturedAt,
        accountId: ctx.hdfcId,
        amountPaise: 8_020_000,
        kind: "salary",
        expectedYear: 2026,
        expectedMonth: 8,
        commit: true,
      }),
    ]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId, isoDate("2026-08-05"));
    expect(snapshot.events.filter((event) => event.meaning === "income")).toHaveLength(1);
    expect(snapshot.fundingCycles.filter((cycle) => cycle.year === 2026 && cycle.month === 8)).toHaveLength(1);
    const schedule = await salarySchedule(ctx.b, { workspaceId: ctx.workspaceId }, isoDate("2026-08-05"));
    expect(schedule.receivableCycles.some((cycle) => cycle.year === 2026 && cycle.month === 8)).toBe(false);
  });
});

describePg("phase 16b salary concurrency (postgres)", { timeout: pgTimeoutMs }, () => {
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

  it("allows only one salary receipt for the same funding cycle", async () => {
    const ctx = await setupPg();
    await applySalaryPolicy(handles!, { workspaceId: ctx.workspaceId }, AUG);
    const results = await Promise.allSettled([
      recordIncome(handles!, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-pg-salary-a",
        occurredOn: "2026-08-05",
        capturedAt,
        accountId: ctx.hdfcId,
        amountPaise: 8_020_000,
        kind: "salary",
        expectedYear: 2026,
        expectedMonth: 8,
        commit: true,
      }),
      recordIncome(handles!, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-pg-salary-b",
        occurredOn: "2026-08-05",
        capturedAt,
        accountId: ctx.hdfcId,
        amountPaise: 7_920_000,
        kind: "salary",
        expectedYear: 2026,
        expectedMonth: 8,
        commit: true,
      }),
    ]);
    const wins = results.filter((result) => result.status === "fulfilled");
    const losses = results.filter((result) => result.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(isDomain((losses[0] as PromiseRejectedResult).reason, "already_received")).toBe(true);
  });

  it("keeps salary policy versions from overlapping when two changes race", async () => {
    const ctx = await setupPg();
    const results = await Promise.allSettled([
      applySalaryPolicy(handles!, { workspaceId: ctx.workspaceId }, AUG),
      applySalaryPolicy(handles!, { workspaceId: ctx.workspaceId }, {
        expectedAmountPaise: 8_200_000,
        windowStartDay: 4,
        typicalDay: 5,
        windowEndDay: 8,
        effectiveFrom: "2027-01-01",
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const snapshot = await loadSnapshot(handles!, ctx.workspaceId, isoDate("2027-01-05"));
    assertNoPolicyOverlap(snapshot.incomePolicies);
  });
});
