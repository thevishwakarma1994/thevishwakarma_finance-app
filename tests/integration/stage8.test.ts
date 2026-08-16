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

function setup() {
  const handles = openMemoryDatabase();
  applyMigrations(handles);
  const workspaceId = getSoleWorkspaceId(handles);
  const accounts = listAccounts(handles, workspaceId);
  const snapshot = loadSnapshot(handles, workspaceId);
  const hdfc = accounts.find((account) => account.displayName === "HDFC");
  if (!hdfc) throw new Error("Expected seeded HDFC account");
  const grocery = snapshot.categories.find((category) => category.name === "Grocery");
  const household = snapshot.categories.find((category) => category.name === "Household");
  if (!grocery || !household) throw new Error("Expected seeded categories");
  const card = createCard(handles, { workspaceId }, {
    displayName: "ICICI",
    issuer: "ICICI",
    mask: "8001",
    statementDay: 12,
    dueDaysAfterStatement: 18,
    defaultPaymentAccountId: hdfc.id,
  });
  applyOpening(handles, { workspaceId }, {
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

function balance(handles: SqliteHandles, workspaceId: string, accountId: string): number {
  const account = loadSnapshot(handles, workspaceId).accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("Account missing");
  return account.balancePaise;
}

function cardLiability(handles: SqliteHandles, workspaceId: string, cardId: string): number {
  return loadSnapshot(handles, workspaceId)
    .postings.filter((posting) => posting.creditCardId === cardId)
    .reduce((sum, posting) => sum + posting.amountPaise, 0);
}

function expenseTotal(handles: SqliteHandles, workspaceId: string): number {
  return loadSnapshot(handles, workspaceId)
    .postings.filter((posting) => posting.pnl === "expense")
    .reduce((sum, posting) => sum + posting.amountPaise, 0);
}

describe("credit card core", () => {
  let handles: SqliteHandles | undefined;

  afterEach(() => {
    handles?.sqlite.close();
  });

  it("A. records a personal card purchase without moving the bank", () => {
    const ctx = setup();
    handles = ctx.handles;
    const bankBefore = balance(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 300_000 }],
      commit: true,
    });
    expect(cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(300_000);
    expect(expenseTotal(ctx.handles, ctx.workspaceId)).toBe(300_000);
    expect(balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(bankBefore);
    const activity = listActivity(ctx.handles, ctx.workspaceId);
    expect(activity[0]?.meaning).toBe("spend_card");
    expect(activity[0]?.cardLabel).toBe("ICICI •8001");
  });

  it("B. splits a card purchase across categories", () => {
    const ctx = setup();
    handles = ctx.handles;
    recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [
        { categoryId: ctx.groceryId, amountPaise: 180_000 },
        { categoryId: ctx.householdId, amountPaise: 120_000 },
      ],
      commit: true,
    });
    const snapshot = loadSnapshot(ctx.handles, ctx.workspaceId);
    const expenses = snapshot.postings.filter((posting) => posting.pnl === "expense");
    expect(expenses).toHaveLength(2);
    expect(expenses.find((posting) => posting.categoryId === ctx.groceryId)?.amountPaise).toBe(180_000);
    expect(expenses.find((posting) => posting.categoryId === ctx.householdId)?.amountPaise).toBe(120_000);
    expect(cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(300_000);
  });

  it("C–E. pays a card in full and partial steps and rejects an overpay atomically", () => {
    const ctx = setup();
    handles = ctx.handles;
    recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 1_000_000 }],
      commit: true,
    });
    const cycleId = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles[0]?.id;
    if (!cycleId) throw new Error("Expected cycle");
    const spend = expenseTotal(ctx.handles, ctx.workspaceId);
    const bankBefore = balance(ctx.handles, ctx.workspaceId, ctx.hdfcId);

    payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-20",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 600_000,
      commit: true,
    });
    expect(balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(bankBefore - 600_000);
    expect(cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(400_000);
    expect(expenseTotal(ctx.handles, ctx.workspaceId)).toBe(spend);

    payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-21",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 400_000,
      commit: true,
    });
    const paid = cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-21"));
    expect(paid.ledgerRemainingPaise).toBe(0);
    expect(paid.statementRemainingPaise).toBe(0);
    expect(paid.remainingPaise).toBe(0);
    expect(paid.lifecycle).toBe("paid");

    const counts = tableCounts(ctx.handles, ctx.workspaceId);
    expect(() =>
      payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-09-22",
        capturedAt,
        creditCardId: ctx.cardId,
        billingCycleId: cycleId,
        accountId: ctx.hdfcId,
        amountPaise: 1,
        commit: true,
      }),
    ).toThrow(DomainError);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(counts);
    expect(cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(0);
  });

  it("F–G. derives expected statement and preserves an actual mismatch", () => {
    const ctx = setup();
    handles = ctx.handles;
    recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 240_000 }],
      commit: true,
    });
    const cycleId = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles[0]?.id;
    if (!cycleId) throw new Error("Expected cycle");
    const expected = cycleDetail(ctx.handles, ctx.workspaceId, cycleId);
    expect(expected.expectedAmountPaise).toBe(240_000);
    expect(expected.actualStatementAmountPaise).toBeNull();

    const result = confirmStatement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cycleId,
      actualStatementAmountPaise: 250_000,
      actualStatementOn: "2026-09-12",
      actualDueOn: "2026-09-30",
    });
    expect(result.mismatch).toBe(true);
    expect(result.warning).toMatch(/mismatch/i);
    const recorded = cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-12"));
    expect(recorded.expectedAmountPaise).toBe(240_000);
    expect(recorded.actualStatementAmountPaise).toBe(250_000);
    expect(recorded.mismatch).toBe(true);
    expect(recorded.ledgerRemainingPaise).toBe(240_000);
    expect(recorded.statementRemainingPaise).toBe(250_000);
    expect(recorded.remainingPaise).toBe(240_000);
    expect(recorded.lifecycle).not.toBe("paid");
  });

  it("H–I. includes card purchases in Month Review by purchase date, not payments", () => {
    const ctx = setup();
    handles = ctx.handles;
    recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 240_000 }],
      commit: true,
    });
    const august = monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    expect(august.spentPaise).toBe(240_000);
    const cycleId = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles[0]?.id;
    if (!cycleId) throw new Error("Expected cycle");
    payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-20",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 240_000,
      commit: true,
    });
    expect(monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16")).spentPaise).toBe(240_000);
    expect(monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-09-16")).spentPaise).toBe(0);
    const payment = listActivity(ctx.handles, ctx.workspaceId).find(
      (event) => event.meaning === "pay_obligation",
    );
    expect(payment?.cardLabel).toBe("ICICI •8001");
  });

  it("J. does not rewrite an already-created cycle when card config changes", () => {
    const ctx = setup();
    handles = ctx.handles;
    recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 100_000 }],
      commit: true,
    });
    const before = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles[0];
    if (!before) throw new Error("Expected cycle");
    expect(before.ruleSnapshot.statementDay).toBe(12);
    updateCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cardId: ctx.cardId,
      statementDay: 15,
      ruleEffectiveFrom: "2026-08-21",
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles.find(
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

  it("lists cards with outstanding, open cycle, and next due", () => {
    const ctx = setup();
    handles = ctx.handles;
    recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 240_000 }],
      commit: true,
    });
    const cards = listCards(ctx.handles, ctx.workspaceId, isoDate("2026-08-20"));
    expect(cards[0]?.label).toBe("ICICI •8001");
    expect(cards[0]?.outstandingPaise).toBe(240_000);
    expect(cards[0]?.currentCycle?.expectedStatementOn).toBe("2026-09-12");
    expect(cards[0]?.nextDueOn).toBe("2026-09-30");
    const detail = cardDetail(ctx.handles, ctx.workspaceId, ctx.cardId, isoDate("2026-08-20"));
    expect(detail.transactions).toHaveLength(1);
    expect(detail.cycles).toHaveLength(1);
  });
});

describe("statement mismatch payment semantics", () => {
  let handles: SqliteHandles | undefined;

  afterEach(() => {
    handles?.sqlite.close();
  });

  function spendAndConfirm(
    ctx: ReturnType<typeof setup>,
    ledgerPaise: number,
    actualPaise: number,
  ) {
    recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: ledgerPaise }],
      commit: true,
    });
    const cycleId = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles[0]?.id;
    if (!cycleId) throw new Error("Expected cycle");
    confirmStatement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cycleId,
      actualStatementAmountPaise: actualPaise,
      actualStatementOn: "2026-09-12",
      actualDueOn: "2026-09-30",
    });
    return cycleId;
  }

  it("A. rejects paying an actual statement above ledger-backed liability", () => {
    const ctx = setup();
    handles = ctx.handles;
    const cycleId = spendAndConfirm(ctx, 1_000_000, 1_050_000);
    const counts = tableCounts(ctx.handles, ctx.workspaceId);
    const bank = balance(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    expect(() =>
      payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-09-20",
        capturedAt,
        creditCardId: ctx.cardId,
        billingCycleId: cycleId,
        accountId: ctx.hdfcId,
        amountPaise: 1_050_000,
        commit: true,
      }),
    ).toThrow(DomainError);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(counts);
    expect(balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(bank);
    expect(cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(1_000_000);
    const cycle = cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-12"));
    expect(cycle.mismatch).toBe(true);
    expect(cycle.ledgerRemainingPaise).toBe(1_000_000);
    expect(cycle.statementRemainingPaise).toBe(1_050_000);
    expect(cycle.lifecycle).not.toBe("paid");
  });

  it("B. paying ledger amount leaves statement remainder and mismatch", () => {
    const ctx = setup();
    handles = ctx.handles;
    const cycleId = spendAndConfirm(ctx, 1_000_000, 1_050_000);
    payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-20",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 1_000_000,
      commit: true,
    });
    const cycle = cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-20"));
    expect(cycle.ledgerRemainingPaise).toBe(0);
    expect(cycle.statementRemainingPaise).toBe(50_000);
    expect(cycle.mismatch).toBe(true);
    expect(cycle.lifecycle).not.toBe("paid");
    expect(cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(0);
  });

  it("C. paying a lower actual statement does not settle leftover ledger liability", () => {
    const ctx = setup();
    handles = ctx.handles;
    const cycleId = spendAndConfirm(ctx, 1_000_000, 950_000);
    payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-20",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 950_000,
      commit: true,
    });
    const cycle = cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-20"));
    expect(cycle.statementRemainingPaise).toBe(0);
    expect(cycle.ledgerRemainingPaise).toBe(50_000);
    expect(cycle.mismatch).toBe(true);
    expect(cycle.lifecycle).not.toBe("paid");
    expect(cardLiability(ctx.handles, ctx.workspaceId, ctx.cardId)).toBe(50_000);
  });

  it("D. matching statement pays both remainings to zero", () => {
    const ctx = setup();
    handles = ctx.handles;
    const cycleId = spendAndConfirm(ctx, 1_000_000, 1_000_000);
    payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-09-20",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycleId,
      accountId: ctx.hdfcId,
      amountPaise: 1_000_000,
      commit: true,
    });
    const cycle = cycleDetail(ctx.handles, ctx.workspaceId, cycleId, isoDate("2026-09-20"));
    expect(cycle.ledgerRemainingPaise).toBe(0);
    expect(cycle.statementRemainingPaise).toBe(0);
    expect(cycle.mismatch).toBe(false);
    expect(cycle.lifecycle).toBe("paid");
  });
});
