import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DbHandles, type SqliteHandles } from "../../src/db/client.js";
import { openPostgresDatabase } from "../../src/db/pg/client.js";
import { applyMigrations, getSoleWorkspaceId, LEGACY_WORKSPACE_NAME } from "../../src/db/migrate.js";
import { applyPostgresMigrations, truncatePostgresData } from "../../src/db/pg/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { anyDb, tables } from "../../src/db/exec.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { createAccount } from "../../src/app/accounts.js";
import { createCard } from "../../src/app/cards.js";
import { recordExpense } from "../../src/app/recordExpense.js";
import { recordIncome } from "../../src/app/recordIncome.js";
import { applyOpeningReservation } from "../../src/app/openingReservation.js";
import { correctOtherIncomeTransaction } from "../../src/app/correctOtherIncome.js";
import { accountAvailability } from "../../src/domain/engine/liquidity.js";
import { utcNowIso } from "../../src/domain/calendar/kolkata.js";
import { newId } from "../../src/domain/ids.js";
import { DomainError } from "../../src/domain/ledger/types.js";

const capturedAt = "2026-08-01T10:00:00.000Z";
const postgresUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const describePg = postgresUrl ? describe : describe.skip;

function isDomain(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}

async function seedWorkspace(handles: DbHandles) {
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  const grocery = snapshot.categories.find((category) => category.name === "Grocery");
  if (!hdfc || !grocery) throw new Error("Expected seeded HDFC and Grocery");
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfc.id,
    effectiveOn: "2026-08-01",
    balancePaise: 10_000_00,
    commit: true,
  });
  const pnb = await createAccount(handles, { workspaceId }, {
    displayName: "PNB",
    kind: "bank",
    openingBalancePaise: 5_000_00,
    openingEffectiveOn: "2026-08-01",
  });
  return { workspaceId, hdfcId: hdfc.id, groceryId: grocery.id, pnbId: pnb.id };
}

async function seedPostgres(handles: DbHandles) {
  const workspaceId = newId();
  const now = utcNowIso();
  const t = tables(handles);
  const db = anyDb(handles);
  const hdfcId = newId();
  const groceryId = newId();
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
    id: groceryId,
    workspaceId,
    parentId: null,
    name: "Grocery",
    archivedAt: null,
  });
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfcId,
    effectiveOn: "2026-08-01",
    balancePaise: 10_000_00,
    commit: true,
  });
  const pnb = await createAccount(handles, { workspaceId }, {
    displayName: "PNB",
    kind: "bank",
    openingBalancePaise: 5_000_00,
    openingEffectiveOn: "2026-08-01",
  });
  return { workspaceId, hdfcId, groceryId, pnbId: pnb.id };
}

async function receive(handles: DbHandles, workspaceId: string, accountId: string, amountPaise: number) {
  return recordIncome(handles, { workspaceId }, {
    occurredOn: "2026-08-01",
    capturedAt,
    accountId,
    amountPaise,
    kind: "other",
    commit: true,
  });
}

async function assertSameTargetRace(left: DbHandles, right: DbHandles, workspaceId: string, hdfcId: string) {
  const original = await receive(left, workspaceId, hdfcId, 5_000_00);
  const results = await Promise.allSettled([
    correctOtherIncomeTransaction(left, { workspaceId }, {
      commandId: "corr-a",
      rootEventId: original.eventId,
      targetEventId: original.eventId,
      amountPaise: 4_500_00,
      destinationAccountId: hdfcId,
      occurredOn: "2026-08-01",
      capturedAt,
      commit: true,
    }),
    correctOtherIncomeTransaction(right, { workspaceId }, {
      commandId: "corr-b",
      rootEventId: original.eventId,
      targetEventId: original.eventId,
      amountPaise: 4_000_00,
      destinationAccountId: hdfcId,
      occurredOn: "2026-08-01",
      capturedAt,
      commit: true,
    }),
  ]);
  const wins = results.filter((result) => result.status === "fulfilled");
  const losses = results.filter((result) => result.status === "rejected");
  expect(wins).toHaveLength(1);
  expect(losses).toHaveLength(1);
  const reason = (losses[0] as PromiseRejectedResult).reason;
  expect(isDomain(reason, "stale_correction_target") || isDomain(reason, "idempotency_conflict")).toBe(true);
  const snapshot = await loadSnapshot(left, workspaceId);
  expect(snapshot.transactionCorrections).toHaveLength(1);
}

async function assertDecreaseVsExpense(
  left: DbHandles,
  right: DbHandles,
  workspaceId: string,
  hdfcId: string,
  groceryId: string,
) {
  const original = await receive(left, workspaceId, hdfcId, 5_000_00);
  const results = await Promise.allSettled([
    correctOtherIncomeTransaction(left, { workspaceId }, {
      commandId: "dec-corr",
      rootEventId: original.eventId,
      targetEventId: original.eventId,
      amountPaise: 1_000_00,
      destinationAccountId: hdfcId,
      occurredOn: "2026-08-01",
      capturedAt,
      commit: true,
    }),
    recordExpense(right, { workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: hdfcId,
      allocations: [{ categoryId: groceryId, amountPaise: 12_000_00 }],
      commit: true,
    }),
  ]);
  const snapshot = await loadSnapshot(left, workspaceId);
  expect(snapshot.accounts.find((account) => account.id === hdfcId)?.balancePaise).toBeGreaterThanOrEqual(0);
  expect(accountAvailability(snapshot, hdfcId).availablePaise).toBeGreaterThanOrEqual(0);
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
}

async function assertAccountChangeVsExpense(
  left: DbHandles,
  right: DbHandles,
  workspaceId: string,
  hdfcId: string,
  pnbId: string,
  groceryId: string,
) {
  const original = await receive(left, workspaceId, hdfcId, 5_000_00);
  const results = await Promise.allSettled([
    correctOtherIncomeTransaction(left, { workspaceId }, {
      commandId: "move-pnb",
      rootEventId: original.eventId,
      targetEventId: original.eventId,
      amountPaise: 5_000_00,
      destinationAccountId: pnbId,
      occurredOn: "2026-08-01",
      capturedAt,
      commit: true,
    }),
    recordExpense(right, { workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: hdfcId,
      allocations: [{ categoryId: groceryId, amountPaise: 12_000_00 }],
      commit: true,
    }),
  ]);
  const snapshot = await loadSnapshot(left, workspaceId);
  expect(snapshot.accounts.find((account) => account.id === hdfcId)?.balancePaise).toBeGreaterThanOrEqual(0);
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
}

describe("phase 16c2 other-income correction concurrency (sqlite)", () => {
  const cleanup: Array<{ handles: SqliteHandles[]; dir: string }> = [];

  afterEach(() => {
    for (const item of cleanup.splice(0)) {
      for (const handles of item.handles) handles.sqlite.close();
      fs.rmSync(item.dir, { recursive: true, force: true });
    }
  });

  async function dualSqlite() {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "tmp-16c2-lock-"));
    const dbPath = path.join(dir, "ledger.sqlite");
    const a = openDatabase(dbPath);
    await applyMigrations(a);
    const b = openDatabase(dbPath);
    cleanup.push({ handles: [a, b], dir });
    const seeded = await seedWorkspace(a);
    return { a, b, ...seeded };
  }

  it("lets only one of two same-target corrections commit", async () => {
    const ctx = await dualSqlite();
    await assertSameTargetRace(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId);
  });

  it("does not allow a decrease vs expense to go negative", async () => {
    const ctx = await dualSqlite();
    await assertDecreaseVsExpense(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.groceryId);
  });

  it("does not allow a destination change vs expense to remove income that was spent", async () => {
    const ctx = await dualSqlite();
    await assertAccountChangeVsExpense(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.pnbId, ctx.groceryId);
  });

  it("does not overcommit reserved HDFC against a destination-account correction", async () => {
    const ctx = await dualSqlite();
    const card = await createCard(ctx.a, { workspaceId: ctx.workspaceId }, {
      displayName: "ICICI",
      issuer: "ICICI",
      mask: "8001",
      statementDay: 12,
      dueDaysAfterStatement: 18,
      defaultPaymentAccountId: ctx.hdfcId,
    });
    const original = await receive(ctx.a, ctx.workspaceId, ctx.hdfcId, 5_000_00);
    const results = await Promise.allSettled([
      correctOtherIncomeTransaction(ctx.a, { workspaceId: ctx.workspaceId }, {
        commandId: "vs-res",
        rootEventId: original.eventId,
        targetEventId: original.eventId,
        amountPaise: 5_000_00,
        destinationAccountId: ctx.pnbId,
        occurredOn: "2026-08-01",
        capturedAt,
        commit: true,
      }),
      applyOpeningReservation(ctx.b, { workspaceId: ctx.workspaceId }, {
        commandId: "res-vs-corr",
        occurredOn: "2026-08-05",
        capturedAt,
        sourceAccountId: ctx.hdfcId,
        cardId: card.id,
        amountPaise: 12_000_00,
      }),
    ]);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId);
    expect(accountAvailability(snapshot, ctx.hdfcId).availablePaise).toBeGreaterThanOrEqual(0);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  });

  it("does not deadlock when two destination-account corrections lock in opposite order", async () => {
    const ctx = await dualSqlite();
    const first = await receive(ctx.a, ctx.workspaceId, ctx.hdfcId, 2_000_00);
    const second = await receive(ctx.a, ctx.workspaceId, ctx.pnbId, 2_000_00);
    const results = await Promise.allSettled([
      correctOtherIncomeTransaction(ctx.a, { workspaceId: ctx.workspaceId }, {
        commandId: "hdfc-to-pnb",
        rootEventId: first.eventId,
        targetEventId: first.eventId,
        amountPaise: 2_000_00,
        destinationAccountId: ctx.pnbId,
        occurredOn: "2026-08-01",
        capturedAt,
        commit: true,
      }),
      correctOtherIncomeTransaction(ctx.b, { workspaceId: ctx.workspaceId }, {
        commandId: "pnb-to-hdfc",
        rootEventId: second.eventId,
        targetEventId: second.eventId,
        amountPaise: 2_000_00,
        destinationAccountId: ctx.hdfcId,
        occurredOn: "2026-08-01",
        capturedAt,
        commit: true,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
  });
});

describePg("phase 16c2 other-income correction concurrency (postgres)", { timeout: 120_000 }, () => {
  const pools: ReturnType<typeof openPostgresDatabase>[] = [];

  afterEach(async () => {
    for (const handles of pools.splice(0)) {
      await truncatePostgresData(handles).catch(() => undefined);
      await closeDatabase(handles);
    }
  });

  async function dualPg() {
    const a = openPostgresDatabase(postgresUrl);
    const b = openPostgresDatabase(postgresUrl);
    pools.push(a, b);
    await applyPostgresMigrations(a);
    await truncatePostgresData(a);
    const seeded = await seedPostgres(a);
    return { a, b, ...seeded };
  }

  it("lets only one of two same-target corrections commit", async () => {
    const ctx = await dualPg();
    await assertSameTargetRace(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId);
  });

  it("does not allow a decrease vs expense to go negative", async () => {
    const ctx = await dualPg();
    await assertDecreaseVsExpense(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.groceryId);
  });

  it("does not allow a destination change vs expense to remove income that was spent", async () => {
    const ctx = await dualPg();
    await assertAccountChangeVsExpense(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.pnbId, ctx.groceryId);
  });

  it("does not overcommit reserved HDFC against a destination-account correction", async () => {
    const ctx = await dualPg();
    const card = await createCard(ctx.a, { workspaceId: ctx.workspaceId }, {
      displayName: "ICICI",
      issuer: "ICICI",
      mask: "8001",
      statementDay: 12,
      dueDaysAfterStatement: 18,
      defaultPaymentAccountId: ctx.hdfcId,
    });
    const original = await receive(ctx.a, ctx.workspaceId, ctx.hdfcId, 5_000_00);
    const results = await Promise.allSettled([
      correctOtherIncomeTransaction(ctx.a, { workspaceId: ctx.workspaceId }, {
        commandId: "vs-res",
        rootEventId: original.eventId,
        targetEventId: original.eventId,
        amountPaise: 5_000_00,
        destinationAccountId: ctx.pnbId,
        occurredOn: "2026-08-01",
        capturedAt,
        commit: true,
      }),
      applyOpeningReservation(ctx.b, { workspaceId: ctx.workspaceId }, {
        commandId: "res-vs-corr",
        occurredOn: "2026-08-05",
        capturedAt,
        sourceAccountId: ctx.hdfcId,
        cardId: card.id,
        amountPaise: 12_000_00,
      }),
    ]);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId);
    expect(accountAvailability(snapshot, ctx.hdfcId).availablePaise).toBeGreaterThanOrEqual(0);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  });

  it("does not deadlock when two destination-account corrections lock in opposite order", async () => {
    const ctx = await dualPg();
    const first = await receive(ctx.a, ctx.workspaceId, ctx.hdfcId, 2_000_00);
    const second = await receive(ctx.a, ctx.workspaceId, ctx.pnbId, 2_000_00);
    const results = await Promise.allSettled([
      correctOtherIncomeTransaction(ctx.a, { workspaceId: ctx.workspaceId }, {
        commandId: "hdfc-to-pnb",
        rootEventId: first.eventId,
        targetEventId: first.eventId,
        amountPaise: 2_000_00,
        destinationAccountId: ctx.pnbId,
        occurredOn: "2026-08-01",
        capturedAt,
        commit: true,
      }),
      correctOtherIncomeTransaction(ctx.b, { workspaceId: ctx.workspaceId }, {
        commandId: "pnb-to-hdfc",
        rootEventId: second.eventId,
        targetEventId: second.eventId,
        amountPaise: 2_000_00,
        destinationAccountId: ctx.hdfcId,
        occurredOn: "2026-08-01",
        capturedAt,
        commit: true,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
  });
});
