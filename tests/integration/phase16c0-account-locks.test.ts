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
import { createPerson } from "../../src/app/people.js";
import { recordExpense } from "../../src/app/recordExpense.js";
import { recordIncome } from "../../src/app/recordIncome.js";
import { recordCardSpend } from "../../src/app/recordCardSpend.js";
import { transferMoney } from "../../src/app/transferMoney.js";
import { applyOpeningReservation } from "../../src/app/openingReservation.js";
import { applySalaryPolicy } from "../../src/app/salaryPolicy.js";
import { lendMoney } from "../../src/app/lendMoney.js";
import { receiveSettlement } from "../../src/app/receiveSettlement.js";
import { resolveSurplus } from "../../src/app/resolveSurplus.js";
import { payCard } from "../../src/app/payCard.js";
import { persistAtomicCorrection } from "../../src/db/persistCorrection.js";
import { withAccountWriteLocks } from "../../src/db/accountWriteLock.js";
import { accountAvailability } from "../../src/domain/engine/liquidity.js";
import { buildTransactionReversal } from "../../src/domain/corrections/reversal.js";
import { snapshotAfterReversal } from "../../src/domain/corrections/overlay.js";
import { recordExpense as recordExpenseDomain } from "../../src/domain/commands/recordExpense.js";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
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
    balancePaise: 50_000_00,
    commit: true,
  });
  const cash = await createAccount(handles, { workspaceId }, {
    displayName: "Cash",
    kind: "cash",
    openingBalancePaise: 10_000_00,
    openingEffectiveOn: "2026-08-01",
  });
  return { workspaceId, hdfcId: hdfc.id, groceryId: grocery.id, cashId: cash.id };
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
    balancePaise: 50_000_00,
    commit: true,
  });
  const cash = await createAccount(handles, { workspaceId }, {
    displayName: "Cash",
    kind: "cash",
    openingBalancePaise: 10_000_00,
    openingEffectiveOn: "2026-08-01",
  });
  return { workspaceId, hdfcId, groceryId, cashId: cash.id };
}

async function assertSameAccountSerializes(left: DbHandles, right: DbHandles, workspaceId: string, hdfcId: string, groceryId: string) {
  const results = await Promise.allSettled([
    recordExpense(left, { workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: hdfcId,
      allocations: [{ categoryId: groceryId, amountPaise: 1_000_00 }],
      commit: true,
    }),
    recordExpense(right, { workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: hdfcId,
      allocations: [{ categoryId: groceryId, amountPaise: 2_000_00 }],
      commit: true,
    }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
  const snapshot = await loadSnapshot(left, workspaceId);
  expect(snapshot.events.filter((event) => event.meaning === "spend_account")).toHaveLength(2);
}

async function assertReversedTransfersDoNotDeadlock(
  left: DbHandles,
  right: DbHandles,
  workspaceId: string,
  hdfcId: string,
  cashId: string,
) {
  const results = await Promise.allSettled([
    transferMoney(left, { workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      amountPaise: 500_00,
      fromAccountId: hdfcId,
      toAccountId: cashId,
      commit: true,
    }),
    transferMoney(right, { workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      amountPaise: 200_00,
      fromAccountId: cashId,
      toAccountId: hdfcId,
      commit: true,
    }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
}

async function persistCorrectionFor(
  handles: DbHandles,
  workspaceId: string,
  hdfcId: string,
  groceryId: string,
  targetEventId: string,
  commandId: string,
  amountPaise: number,
) {
  const snapshot = await loadSnapshot(handles, workspaceId);
  const target = snapshot.events.find((event) => event.id === targetEventId);
  if (!target) throw new Error("target missing");
  const targetPostings = snapshot.postings.filter((posting) => posting.eventId === target.id);
  const reversal = buildTransactionReversal(target, targetPostings, "2026-08-20T10:00:00.000Z");
  const afterReversal = snapshotAfterReversal(
    snapshot,
    { events: [reversal.event], postings: reversal.postings },
    isoDate("2026-08-20"),
  );
  const replacement = recordExpenseDomain(
    {
      occurredOn: target.occurredOn,
      capturedAt: "2026-08-20T10:00:00.000Z",
      accountId: hdfcId,
      allocations: [{ categoryId: groceryId, amountPaise: paise(amountPaise) }],
    },
    afterReversal,
  );
  return persistAtomicCorrection(handles, workspaceId, {
    commandId,
    rootEventId: target.id,
    targetEventId: target.id,
    targetEvent: target,
    targetPostings,
    reversalEvent: reversal.event,
    reversalPostings: reversal.postings,
    replacementEvent: replacement.batch.events[0]!,
    replacementPostings: replacement.batch.postings,
    correctedOn: "2026-08-20",
    capturedAt: "2026-08-20T10:00:00.000Z",
  });
}

async function persistLockedCorrectionFor(
  handles: DbHandles,
  workspaceId: string,
  hdfcId: string,
  groceryId: string,
  targetEventId: string,
  commandId: string,
  amountPaise: number,
) {
  return withAccountWriteLocks(handles, workspaceId, [hdfcId], (tx) =>
    persistCorrectionFor(tx, workspaceId, hdfcId, groceryId, targetEventId, commandId, amountPaise),
  );
}

describe("phase 16c0 account-write serialization (sqlite two connections)", () => {
  const cleanup: Array<{ handles: SqliteHandles[]; dir: string }> = [];

  afterEach(() => {
    for (const item of cleanup.splice(0)) {
      for (const handles of item.handles) handles.sqlite.close();
      fs.rmSync(item.dir, { recursive: true, force: true });
    }
  });

  async function dualSqlite() {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "tmp-account-lock-"));
    const dbPath = path.join(dir, "ledger.sqlite");
    const a = openDatabase(dbPath);
    await applyMigrations(a);
    const b = openDatabase(dbPath);
    cleanup.push({ handles: [a, b], dir });
    const seeded = await seedWorkspace(a);
    return { a, b, ...seeded };
  }

  it("serializes two writers on the same account", async () => {
    const ctx = await dualSqlite();
    await assertSameAccountSerializes(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.groceryId);
  });

  it("locks two accounts in deterministic order without deadlock when call order is reversed", async () => {
    const ctx = await dualSqlite();
    await assertReversedTransfersDoNotDeadlock(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.cashId);
  });

  it("rejects a concurrent second correction of the same target", async () => {
    const ctx = await dualSqlite();
    const original = await recordExpense(ctx.a, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 1_200_00 }],
      commit: true,
    });
    const results = await Promise.allSettled([
      persistCorrectionFor(ctx.a, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, original.eventId!, "corr-a", 800_00),
      persistCorrectionFor(ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, original.eventId!, "corr-b", 900_00),
    ]);
    const wins = results.filter((result) => result.status === "fulfilled");
    const losses = results.filter((result) => result.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    const reason = (losses[0] as PromiseRejectedResult).reason;
    expect(isDomain(reason, "stale_correction_target") || isDomain(reason, "idempotency_conflict")).toBe(true);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId);
    expect(snapshot.transactionCorrections).toHaveLength(1);
  });

  it("releases the account gate after a callback throw so a later writer succeeds", async () => {
    const ctx = await dualSqlite();
    await expect(
      withAccountWriteLocks(ctx.a, ctx.workspaceId, [ctx.hdfcId], async () => {
        throw new Error("account lock boom");
      }),
    ).rejects.toThrow(/account lock boom/);
    await recordExpense(ctx.b, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 100_00 }],
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId);
    expect(snapshot.events.filter((event) => event.meaning === "spend_account")).toHaveLength(1);
  });

  it("releases a two-account lock after a callback throw", async () => {
    const ctx = await dualSqlite();
    await expect(
      withAccountWriteLocks(ctx.a, ctx.workspaceId, [ctx.hdfcId, ctx.cashId], async () => {
        throw new Error("two account boom");
      }),
    ).rejects.toThrow(/two account boom/);
    await transferMoney(ctx.b, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      amountPaise: 100_00,
      fromAccountId: ctx.hdfcId,
      toAccountId: ctx.cashId,
      commit: true,
    });
  });

  it("serializes a future correction-account lock against a real opening reservation", async () => {
    const ctx = await dualSqlite();
    const card = await createCard(ctx.a, { workspaceId: ctx.workspaceId }, {
      displayName: "ICICI",
      issuer: "ICICI",
      mask: "8001",
      statementDay: 12,
      dueDaysAfterStatement: 18,
      defaultPaymentAccountId: ctx.hdfcId,
    });
    const original = await recordExpense(ctx.a, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 1_000_00 }],
      commit: true,
    });
    const results = await Promise.allSettled([
      persistLockedCorrectionFor(
        ctx.a,
        ctx.workspaceId,
        ctx.hdfcId,
        ctx.groceryId,
        original.eventId!,
        "corr-vs-res",
        7_000_00,
      ),
      applyOpeningReservation(ctx.b, { workspaceId: ctx.workspaceId }, {
        commandId: "res-vs-corr",
        occurredOn: "2026-08-05",
        capturedAt,
        sourceAccountId: ctx.hdfcId,
        cardId: card.id,
        amountPaise: 5_000_00,
      }),
    ]);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId);
    const reserved = snapshot.reservations.reduce((sum, row) => sum + row.remainingPaise, 0);
    const spent = snapshot.postings
      .filter((posting) => posting.pnl === "expense")
      .reduce((sum, posting) => sum + posting.amountPaise, 0);
    expect(reserved + spent).toBeLessThanOrEqual(50_000_00);
    expect(results.filter((result) => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(accountAvailability(snapshot, ctx.hdfcId).availablePaise).toBeGreaterThanOrEqual(0);
  });

  it("serializes surplus resolution against a locked future correction", async () => {
    const ctx = await dualSqlite();
    const rahul = await createPerson(ctx.a, { workspaceId: ctx.workspaceId }, { name: "Rahul" });
    await lendMoney(ctx.a, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: rahul.id,
      amountPaise: 8_000_00,
      commit: true,
    });
    const claim = (await loadSnapshot(ctx.a, ctx.workspaceId)).claims[0];
    if (!claim) throw new Error("missing claim");
    await receiveSettlement(ctx.a, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: rahul.id,
      amountPaise: 8_000_00,
      allocations: [{ claimId: claim.id, amountPaise: 1_000_00 }],
      commit: true,
    });
    const surplus = (await loadSnapshot(ctx.a, ctx.workspaceId)).surplusCases[0];
    if (!surplus) throw new Error("missing surplus");
    const original = await recordExpense(ctx.a, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 500_00 }],
      commit: true,
    });
    const results = await Promise.allSettled([
      persistLockedCorrectionFor(
        ctx.a,
        ctx.workspaceId,
        ctx.hdfcId,
        ctx.groceryId,
        original.eventId!,
        "corr-vs-surplus",
        4_000_00,
      ),
      resolveSurplus(ctx.b, { workspaceId: ctx.workspaceId }, {
        surplusCaseId: surplus.id,
        resolution: "treat_as_mine_correction",
        confirmed: true,
        occurredOn: "2026-08-20",
        capturedAt: "2026-08-20T10:00:00.000Z",
        commit: true,
      }),
    ]);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId);
    expect(accountAvailability(snapshot, ctx.hdfcId).availablePaise).toBeGreaterThanOrEqual(0);
    const spent = snapshot.postings
      .filter((posting) => posting.pnl === "expense")
      .reduce((sum, posting) => sum + posting.amountPaise, 0);
    const pending = snapshot.surplusCases
      .filter((item) => item.status === "pending")
      .reduce((sum, item) => sum + item.amountPaise, 0);
    expect(spent + pending).toBeLessThanOrEqual(50_000_00);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  });

  it("composes card→account payCard with a concurrent account writer without deadlock", async () => {
    const ctx = await dualSqlite();
    const card = await createCard(ctx.a, { workspaceId: ctx.workspaceId }, {
      displayName: "Axis",
      issuer: "Axis",
      mask: "4321",
      statementDay: 12,
      dueDaysAfterStatement: 18,
      defaultPaymentAccountId: ctx.hdfcId,
    });
    await recordCardSpend(ctx.a, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      creditCardId: card.id,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 1_000_00 }],
      commit: true,
    });
    const cycle = (await loadSnapshot(ctx.a, ctx.workspaceId)).billingCycles.find((row) => row.creditCardId === card.id);
    if (!cycle) throw new Error("missing cycle");
    const results = await Promise.allSettled([
      payCard(ctx.a, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-22",
        capturedAt,
        creditCardId: card.id,
        billingCycleId: cycle.id,
        accountId: ctx.hdfcId,
        amountPaise: 1_000_00,
        commit: true,
      }),
      recordExpense(ctx.b, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-01",
        capturedAt,
        accountId: ctx.hdfcId,
        allocations: [{ categoryId: ctx.groceryId, amountPaise: 2_000_00 }],
        commit: true,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId);
    expect(accountAvailability(snapshot, ctx.hdfcId).availablePaise).toBeGreaterThanOrEqual(0);
  });

  it("composes workspace→account salary receipt with a concurrent account writer", async () => {
    const ctx = await dualSqlite();
    await applySalaryPolicy(ctx.a, { workspaceId: ctx.workspaceId }, {
      expectedAmountPaise: 7_920_000,
      windowStartDay: 4,
      typicalDay: 5,
      windowEndDay: 8,
      effectiveFrom: "2026-08-01",
    });
    const results = await Promise.allSettled([
      recordIncome(ctx.a, { workspaceId: ctx.workspaceId }, {
        commandId: "salary-lock-comp",
        occurredOn: "2026-08-05",
        capturedAt,
        accountId: ctx.hdfcId,
        amountPaise: 8_020_000,
        kind: "salary",
        expectedYear: 2026,
        expectedMonth: 8,
        commit: true,
      }),
      recordExpense(ctx.b, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-01",
        capturedAt,
        accountId: ctx.hdfcId,
        allocations: [{ categoryId: ctx.groceryId, amountPaise: 1_000_00 }],
        commit: true,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    const replay = await recordIncome(ctx.a, { workspaceId: ctx.workspaceId }, {
      commandId: "salary-lock-comp",
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 8_020_000,
      kind: "salary",
      expectedYear: 2026,
      expectedMonth: 8,
      commit: true,
    });
    expect(replay.eventId).toBe("salary-lock-comp");
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId);
    expect(snapshot.events.filter((event) => event.meaning === "income")).toHaveLength(1);
  });
});

describePg("phase 16c0 account-write serialization (postgres)", { timeout: 120_000 }, () => {
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

  it("serializes two writers on the same account", async () => {
    const ctx = await dualPg();
    await assertSameAccountSerializes(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.groceryId);
  });

  it("locks two accounts in deterministic order without deadlock when call order is reversed", async () => {
    const ctx = await dualPg();
    await assertReversedTransfersDoNotDeadlock(ctx.a, ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.cashId);
  });

  it("rejects a concurrent second correction of the same target", async () => {
    const ctx = await dualPg();
    const original = await recordExpense(ctx.a, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 1_200_00 }],
      commit: true,
    });
    const results = await Promise.allSettled([
      persistCorrectionFor(ctx.a, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, original.eventId!, "corr-pg-a", 800_00),
      persistCorrectionFor(ctx.b, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, original.eventId!, "corr-pg-b", 900_00),
    ]);
    const wins = results.filter((result) => result.status === "fulfilled");
    const losses = results.filter((result) => result.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    const snapshot = await loadSnapshot(ctx.a, ctx.workspaceId);
    expect(snapshot.transactionCorrections).toHaveLength(1);
  });

  it("releases the account gate after a callback throw so a later writer succeeds", async () => {
    const ctx = await dualPg();
    await expect(
      withAccountWriteLocks(ctx.a, ctx.workspaceId, [ctx.hdfcId], async () => {
        throw new Error("account lock boom");
      }),
    ).rejects.toThrow(/account lock boom/);
    await recordExpense(ctx.b, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 100_00 }],
      commit: true,
    });
  });
});
