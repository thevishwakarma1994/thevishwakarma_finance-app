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
import { applyOpeningReservation } from "../../src/app/openingReservation.js";
import { correctExpenseTransaction } from "../../src/app/correctExpense.js";
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

async function assertSameTargetRace(left: DbHandles, right: DbHandles, workspaceId: string, hdfcId: string, groceryId: string) {
  const original = await recordExpense(left, { workspaceId }, {
    occurredOn: "2026-08-01",
    capturedAt,
    accountId: hdfcId,
    allocations: [{ categoryId: groceryId, amountPaise: 1_850_00 }],
    commit: true,
  });
  const results = await Promise.allSettled([
    correctExpenseTransaction(left, { workspaceId }, {
      commandId: "corr-a",
      rootEventId: original.eventId,
      targetEventId: original.eventId,
      amountPaise: 1_580_00,
      sourceAccountId: hdfcId,
      occurredOn: "2026-08-01",
      allocations: [{ categoryId: groceryId, amountPaise: 1_580_00 }],
      capturedAt,
      commit: true,
    }),
    correctExpenseTransaction(right, { workspaceId }, {
      commandId: "corr-b",
      rootEventId: original.eventId,
      targetEventId: original.eventId,
      amountPaise: 1_620_00,
      sourceAccountId: hdfcId,
      occurredOn: "2026-08-01",
      allocations: [{ categoryId: groceryId, amountPaise: 1_620_00 }],
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
  expect(snapshot.events.filter((event) => event.meaning === "spend_account" && !snapshot.transactionCorrections.some((row) => row.targetEventId === event.id))).toHaveLength(1);
}

async function assertSourceChangeVsExpense(
  left: DbHandles,
  right: DbHandles,
  workspaceId: string,
  hdfcId: string,
  pnbId: string,
  groceryId: string,
) {
  const original = await recordExpense(left, { workspaceId }, {
    occurredOn: "2026-08-01",
    capturedAt,
    accountId: hdfcId,
    allocations: [{ categoryId: groceryId, amountPaise: 2_000_00 }],
    commit: true,
  });
  const results = await Promise.allSettled([
    correctExpenseTransaction(left, { workspaceId }, {
      commandId: "src-change",
      rootEventId: original.eventId,
      targetEventId: original.eventId,
      amountPaise: 2_000_00,
      sourceAccountId: pnbId,
      occurredOn: "2026-08-01",
      allocations: [{ categoryId: groceryId, amountPaise: 2_000_00 }],
      capturedAt,
      commit: true,
    }),
    recordExpense(right, { workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: pnbId,
      allocations: [{ categoryId: groceryId, amountPaise: 4_000_00 }],
      commit: true,
    }),
  ]);
  const snapshot = await loadSnapshot(left, workspaceId);
  expect(accountAvailability(snapshot, pnbId).availablePaise).toBeGreaterThanOrEqual(0);
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  if (results.every((result) => result.status === "fulfilled")) {
    expect(snapshot.accounts.find((account) => account.id === pnbId)?.balancePaise).toBeGreaterThanOrEqual(0);
  }
}

describe("phase 16c1 expense correction concurrency (sqlite)", () => {
  const cleanup: Array<{ handles: SqliteHandles[]; dir: string }> = [];

  afterEach(() => {
    for (const item of cleanup.splice(0)) {
      for (const handles of item.handles) handles.sqlite.close();
      fs.rmSync(item.dir, { recursive: true, force: true });
    }
  });

  async function dualSqlite() {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "tmp-16c1-lock-"));
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
    await assertSameTargetRace(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.groceryId);
  });

  it("does not overcommit PNB when a source-change races an expense", async () => {
    const ctx = await dualSqlite();
    await assertSourceChangeVsExpense(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.pnbId, ctx.groceryId);
  });

  it("does not overcommit reserved PNB against a source-change", async () => {
    const ctx = await dualSqlite();
    const card = await createCard(ctx.a, { workspaceId: ctx.workspaceId }, {
      displayName: "ICICI",
      issuer: "ICICI",
      mask: "8001",
      statementDay: 12,
      dueDaysAfterStatement: 18,
      defaultPaymentAccountId: ctx.pnbId,
    });
    const original = await recordExpense(ctx.a, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 2_000_00 }],
      commit: true,
    });
    const results = await Promise.allSettled([
      correctExpenseTransaction(ctx.a, { workspaceId: ctx.workspaceId }, {
        commandId: "vs-res",
        rootEventId: original.eventId,
        targetEventId: original.eventId,
        amountPaise: 2_000_00,
        sourceAccountId: ctx.pnbId,
        occurredOn: "2026-08-01",
        allocations: [{ categoryId: ctx.groceryId, amountPaise: 2_000_00 }],
        capturedAt,
        commit: true,
      }),
      applyOpeningReservation(ctx.b, { workspaceId: ctx.workspaceId }, {
        commandId: "res-vs-corr",
        occurredOn: "2026-08-05",
        capturedAt,
        sourceAccountId: ctx.pnbId,
        cardId: card.id,
        amountPaise: 4_000_00,
      }),
    ]);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId);
    expect(accountAvailability(snapshot, ctx.pnbId).availablePaise).toBeGreaterThanOrEqual(0);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  });
});

describePg("phase 16c1 expense correction concurrency (postgres)", { timeout: 120_000 }, () => {
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
    await assertSameTargetRace(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.groceryId);
  });

  it("does not overcommit PNB when a source-change races an expense", async () => {
    const ctx = await dualPg();
    await assertSourceChangeVsExpense(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.pnbId, ctx.groceryId);
  });
});
