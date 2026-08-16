import { count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import {
  cardDetail,
  cycleDetail,
  listActivity,
  listAccounts,
  listCards,
  monthReview,
} from "../../src/db/reads.js";
import { billingCycles, financialEvents, postings } from "../../src/db/schema.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { recordCardSpend } from "../../src/app/recordCardSpend.js";
import { payCard } from "../../src/app/payCard.js";
import { confirmStatement } from "../../src/app/confirmStatement.js";
import { createCard, updateCard } from "../../src/app/cards.js";

const capturedAt = "2026-08-20T04:30:00.000Z";

async function setup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const accounts = await listAccounts(handles, workspaceId);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = accounts.find((account) => account.displayName === "HDFC");
  if (!hdfc) throw new Error("Expected seeded HDFC account");
  const grocery = snapshot.categories.find((category) => category.name === "Grocery");
  const household = snapshot.categories.find((category) => category.name === "Household");
  if (!grocery || !household) throw new Error("Expected seeded categories");
  const card = await createCard(handles, { workspaceId }, {
    displayName: "ICICI",
    issuer: "ICICI",
    mask: "8001",
    statementDay: 12,
    dueDaysAfterStatement: 18,
    defaultPaymentAccountId: hdfc.id,
  });
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfc.id,
    effectiveOn: "2026-08-01",
    balancePaise: 5_000_000,
    commit: true,
  });
  return {
    handles,
    workspaceId,
    hdfcId: hdfc.id,
    groceryId: grocery.id,
    householdId: household.id,
    cardId: card.id,
  };
}

function tableCounts(handles: SqliteHandles, workspaceId: string) {
  return {
    events:
      handles.db
        .select({ value: count() })
        .from(financialEvents)
        .where(eq(financialEvents.workspaceId, workspaceId))
        .get()?.value ?? 0,
    postings:
      handles.db
        .select({ value: count() })
        .from(postings)
        .where(eq(postings.workspaceId, workspaceId))
        .get()?.value ?? 0,
  };
}

async function balance(handles: SqliteHandles, workspaceId: string, accountId: string): Promise<number> {
  const account = (await loadSnapshot(handles, workspaceId)).accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("Account missing");
  return account.balancePaise;
}

async function cardLiability(handles: SqliteHandles, workspaceId: string, cardId: string): Promise<number> {
  return (await loadSnapshot(handles, workspaceId))
    .postings.filter((posting) => posting.creditCardId === cardId)
    .reduce((sum, posting) => sum + posting.amountPaise, 0);
}

async function expenseTotal(handles: SqliteHandles, workspaceId: string): Promise<number> {
  return (await loadSnapshot(handles, workspaceId))
    .postings.filter((posting) => posting.pnl === "expense")
    .reduce((sum, posting) => sum + posting.amountPaise, 0);
}

describe("credit card core", () => {
  let handles: SqliteHandles | undefined;

  afterEach(() => {
    handles?.sqlite.close();
  });

  it("A. records a personal card purchase without moving the bank", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const bankBefore = await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 300_000 }],
      commit: true,
    });
    expect(await cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(300_000);
    expect(await expenseTotal(ctx.handles, ctx.workspaceId)).toBe(300_000);
    expect(await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(bankBefore);
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity[0]?.meaning).toBe("spend_card");
    expect(activity[0]?.cardLabel).toBe("ICICI •8001");
  });

  it("B. splits a card purchase across categories", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [
        { categoryId: ctx.groceryId, amountPaise: 180_000 },
        { categoryId: ctx.householdId, amountPaise: 120_000 },
      ],
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const expenses = snapshot.postings.filter((posting) => posting.pnl === "expense");
    expect(expenses).toHaveLength(2);
    expect(expenses.find((posting) => posting.categoryId === ctx.groceryId)?.amountPaise).toBe(180_000);
    expect(expenses.find((posting) => posting.categoryId === ctx.householdId)?.amountPaise).toBe(120_000);
    expect(await cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(300_000);
  });

  it("C–E. pays a card in full and partial steps and rejects an overpay atomically", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 1_000_000 }],
      commit: true,
    });
    const cycleId = (await loadSnapshot(ctx.handles, ctx.workspaceId)).billingCycles[0]?.id;
    if (!cycleId) throw new Error("Expected cycle");
    const spend = await expenseTotal(ctx.handles, ctx.workspaceId);
    const bankBefore = await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId);

    await payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-20",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 600_000,
      commit: true,
    });
    expect(await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(bankBefore - 600_000);
    expect(await cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(400_000);
    expect(await expenseTotal(ctx.handles, ctx.workspaceId)).toBe(spend);

    await payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-21",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 400_000,
      commit: true,
    });
    const paid = await cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-21"));
    expect(paid.ledgerRemainingPaise).toBe(0);
    expect(paid.statementRemainingPaise).toBe(0);
    expect(paid.remainingPaise).toBe(0);
    expect(paid.lifecycle).toBe("paid");

    const counts = tableCounts(ctx.handles, ctx.workspaceId);
    await expect(
      payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-09-22",
        capturedAt,
        creditCardId: ctx.cardId,
        billingCycleId: cycleId,
        accountId: ctx.hdfcId,
        amountPaise: 1,
        commit: true,
      }),
    ).rejects.toThrow(DomainError);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(counts);
    expect(await cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(0);
  });

  it("F–G. derives expected statement and preserves an actual mismatch", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 240_000 }],
      commit: true,
    });
    const cycleId = (await loadSnapshot(ctx.handles, ctx.workspaceId)).billingCycles[0]?.id;
    if (!cycleId) throw new Error("Expected cycle");
    const expected = await cycleDetail(ctx.handles, ctx.workspaceId, cycleId);
    expect(expected.expectedAmountPaise).toBe(240_000);
    expect(expected.actualStatementAmountPaise).toBeNull();

    const result = await confirmStatement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cycleId,
      actualStatementAmountPaise: 250_000,
      actualStatementOn: "2026-09-12",
      actualDueOn: "2026-09-30",
    });
    expect(result.mismatch).toBe(true);
    expect(result.warning).toMatch(/mismatch/i);
    const recorded = await cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-12"));
    expect(recorded.expectedAmountPaise).toBe(240_000);
    expect(recorded.actualStatementAmountPaise).toBe(250_000);
    expect(recorded.mismatch).toBe(true);
    expect(recorded.ledgerRemainingPaise).toBe(240_000);
    expect(recorded.statementRemainingPaise).toBe(250_000);
    expect(recorded.remainingPaise).toBe(240_000);
    expect(recorded.lifecycle).not.toBe("paid");
  });

  it("H–I. includes card purchases in Month Review by purchase date, not payments", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 240_000 }],
      commit: true,
    });
    const august = await monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    expect(august.spentPaise).toBe(240_000);
    const cycleId = (await loadSnapshot(ctx.handles, ctx.workspaceId)).billingCycles[0]?.id;
    if (!cycleId) throw new Error("Expected cycle");
    await payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-20",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 240_000,
      commit: true,
    });
    expect((await monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"))).spentPaise).toBe(240_000);
    expect((await monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-09-16"))).spentPaise).toBe(0);
    const payment = (await listActivity(ctx.handles, ctx.workspaceId)).find(
      (event) => event.meaning === "pay_obligation",
    );
    expect(payment?.cardLabel).toBe("ICICI •8001");
  });

  it("J. does not rewrite an already-created cycle when card config changes", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 100_000 }],
      commit: true,
    });
    const before = (await loadSnapshot(ctx.handles, ctx.workspaceId)).billingCycles[0];
    if (!before) throw new Error("Expected cycle");
    expect(before.ruleSnapshot.statementDay).toBe(12);
    await updateCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cardId: ctx.cardId,
      statementDay: 15,
      ruleEffectiveFrom: "2026-08-21",
    });
    const after = (await loadSnapshot(ctx.handles, ctx.workspaceId)).billingCycles.find(
      (cycle) => cycle.id === before.id,
    );
    expect(after?.ruleSnapshot.statementDay).toBe(12);
    expect(after?.expectedStatementOn).toBe(before.expectedStatementOn);
    const row = ctx.handles.db
      .select()
      .from(billingCycles)
      .where(eq(billingCycles.id, before.id))
      .get();
    expect(row?.ruleSnapshot).toBe(JSON.stringify(before.ruleSnapshot));
  });

  it("lists cards with outstanding, open cycle, and next due", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 240_000 }],
      commit: true,
    });
    const cards = await listCards(ctx.handles, ctx.workspaceId, isoDate("2026-08-20"));
    expect(cards[0]?.label).toBe("ICICI •8001");
    expect(cards[0]?.outstandingPaise).toBe(240_000);
    expect(cards[0]?.currentCycle?.expectedStatementOn).toBe("2026-09-12");
    expect(cards[0]?.nextDueOn).toBe("2026-09-30");
    const detail = await cardDetail(ctx.handles, ctx.workspaceId, ctx.cardId, isoDate("2026-08-20"));
    expect(detail.transactions).toHaveLength(1);
    expect(detail.cycles).toHaveLength(1);
  });
});

describe("statement mismatch payment semantics", () => {
  let handles: SqliteHandles | undefined;

  afterEach(() => {
    handles?.sqlite.close();
  });

  async function spendAndConfirm(
    ctx: Awaited<ReturnType<typeof setup>>,
    ledgerPaise: number,
    actualPaise: number,
  ) {
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: ledgerPaise }],
      commit: true,
    });
    const cycleId = (await loadSnapshot(ctx.handles, ctx.workspaceId)).billingCycles[0]?.id;
    if (!cycleId) throw new Error("Expected cycle");
    await confirmStatement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cycleId,
      actualStatementAmountPaise: actualPaise,
      actualStatementOn: "2026-09-12",
      actualDueOn: "2026-09-30",
    });
    return cycleId;
  }

  it("A. rejects paying an actual statement above ledger-backed liability", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const cycleId = await spendAndConfirm(ctx, 1_000_000, 1_050_000);
    const counts = tableCounts(ctx.handles, ctx.workspaceId);
    const bank = await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    await expect(
      payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-09-20",
        capturedAt,
        creditCardId: ctx.cardId,
        billingCycleId: cycleId,
        accountId: ctx.hdfcId,
        amountPaise: 1_050_000,
        commit: true,
      }),
    ).rejects.toThrow(DomainError);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(counts);
    expect(await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(bank);
    expect(await cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(1_000_000);
    const cycle = await cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-12"));
    expect(cycle.mismatch).toBe(true);
    expect(cycle.ledgerRemainingPaise).toBe(1_000_000);
    expect(cycle.statementRemainingPaise).toBe(1_050_000);
    expect(cycle.lifecycle).not.toBe("paid");
  });

  it("B. paying ledger amount leaves statement remainder and mismatch", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const cycleId = await spendAndConfirm(ctx, 1_000_000, 1_050_000);
    await payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-20",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 1_000_000,
      commit: true,
    });
    const cycle = await cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-20"));
    expect(cycle.ledgerRemainingPaise).toBe(0);
    expect(cycle.statementRemainingPaise).toBe(50_000);
    expect(cycle.mismatch).toBe(true);
    expect(cycle.lifecycle).not.toBe("paid");
    expect(await cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(0);
  });

  it("C. paying a lower actual statement does not settle leftover ledger liability", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const cycleId = await spendAndConfirm(ctx, 1_000_000, 950_000);
    await payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-20",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 950_000,
      commit: true,
    });
    const cycle = await cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-20"));
    expect(cycle.statementRemainingPaise).toBe(0);
    expect(cycle.ledgerRemainingPaise).toBe(50_000);
    expect(cycle.mismatch).toBe(true);
    expect(cycle.lifecycle).not.toBe("paid");
    expect(await cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(50_000);
  });

  it("D. matching statement pays both remainings to zero", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const cycleId = await spendAndConfirm(ctx, 1_000_000, 1_000_000);
    await payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-20",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 1_000_000,
      commit: true,
    });
    const cycle = await cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-20"));
    expect(cycle.ledgerRemainingPaise).toBe(0);
    expect(cycle.statementRemainingPaise).toBe(0);
    expect(cycle.mismatch).toBe(false);
    expect(cycle.lifecycle).toBe("paid");
  });
});
