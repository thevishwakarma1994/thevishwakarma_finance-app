import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { assertConservation } from "../../src/domain/conservation/validate.js";
import { recordCardSpend } from "../../src/domain/commands/recordCardSpend.js";
import { payCard } from "../../src/domain/commands/payCard.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import {
  accountFixture,
  cardFixture,
  cycleFixture,
  ICICI_RULE,
  paiseOf,
  snapshotFixture,
} from "./fixtures.js";

const capturedAt = "2026-08-20T04:30:00.000Z";

describe("recordCardSpend", () => {
  it("increases card liability and personal expense without moving the bank", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(50_000) });
    const card = cardFixture();
    const { batch, preview } = recordCardSpend(
      {
        occurredOn: isoDate("2026-08-20"),
        capturedAt,
        creditCardId: card.id,
        allocations: [{ categoryId: "cat-grocery", amountPaise: paiseOf(3_000) }],
        rule: ICICI_RULE,
      },
      snapshotFixture({ accounts: [hdfc], creditCards: [card] }),
    );

    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]?.meaning).toBe("spend_card");
    expect(batch.events[0]?.accountId).toBeNull();
    expect(batch.billingCycles).toHaveLength(1);
    expect(batch.billingCycles?.[0]?.expectedStatementOn).toBe("2026-09-12");
    const cardPosting = batch.postings.find((posting) => posting.creditCardId);
    const expensePosting = batch.postings.find((posting) => posting.pnl === "expense");
    expect(cardPosting?.amountPaise).toBe(300_000);
    expect(expensePosting?.amountPaise).toBe(300_000);
    expect(batch.postings.some((posting) => posting.accountId)).toBe(false);
    expect(() => assertConservation("spend_card", batch)).not.toThrow();
    expect(preview.classifications.spent).toBe(300_000);
  });

  it("keeps one event with multiple expense-category postings", () => {
    const card = cardFixture();
    const { batch } = recordCardSpend(
      {
        occurredOn: isoDate("2026-08-20"),
        capturedAt,
        creditCardId: card.id,
        allocations: [
          { categoryId: "cat-grocery", amountPaise: paiseOf(1_800) },
          { categoryId: "cat-household", amountPaise: paiseOf(1_200) },
        ],
        rule: ICICI_RULE,
      },
      snapshotFixture({ creditCards: [card] }),
    );
    const expense = batch.postings.filter((posting) => posting.pnl === "expense");
    expect(batch.events).toHaveLength(1);
    expect(expense).toHaveLength(2);
    expect(expense.reduce((sum, posting) => sum + posting.amountPaise, 0)).toBe(300_000);
    expect(batch.postings.find((posting) => posting.creditCardId)?.amountPaise).toBe(300_000);
  });

  it("reuses an existing cycle and does not rewrite its snapshot", () => {
    const card = cardFixture();
    const existing = cycleFixture({
      creditCardId: card.id,
      expectedStatementOn: isoDate("2026-09-12"),
      ruleSnapshot: { statementDay: 12, dueDaysAfterStatement: 18 },
    });
    const { batch } = recordCardSpend(
      {
        occurredOn: isoDate("2026-08-20"),
        capturedAt,
        creditCardId: card.id,
        allocations: [{ categoryId: "cat-grocery", amountPaise: paiseOf(500) }],
        rule: ICICI_RULE,
      },
      snapshotFixture({ creditCards: [card], billingCycles: [existing] }),
    );
    expect(batch.billingCycles).toEqual([]);
    expect(batch.events[0]?.billingCycleId).toBe(existing.id);
  });
});

describe("payCard", () => {
  it("reduces the payment account and card liability without personal spending", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(50_000) });
    const card = cardFixture();
    const cycle = cycleFixture({
      creditCardId: card.id,
      expectedAmountPaise: paiseOf(10_000),
      ledgerRemainingPaise: paiseOf(10_000),
      statementRemainingPaise: paiseOf(10_000),
    });
    const { batch, preview } = payCard(
      {
        occurredOn: isoDate("2026-09-20"),
        capturedAt,
        creditCardId: card.id,
        billingCycleId: cycle.id,
        accountId: hdfc.id,
        amountPaise: paiseOf(6_000),
      },
      snapshotFixture({ accounts: [hdfc], creditCards: [card], billingCycles: [cycle] }),
    );
    expect(batch.events[0]?.meaning).toBe("pay_obligation");
    expect(batch.postings.find((posting) => posting.accountId)?.amountPaise).toBe(-600_000);
    expect(batch.postings.find((posting) => posting.creditCardId)?.amountPaise).toBe(-600_000);
    expect(batch.postings.some((posting) => posting.pnl === "expense")).toBe(false);
    expect(preview.classifications.spent).toBe(0);
    expect(() => assertConservation("pay_obligation", batch)).not.toThrow();
  });

  it("rejects payment greater than outstanding without proposing a batch", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(50_000) });
    const card = cardFixture();
    const cycle = cycleFixture({
      creditCardId: card.id,
      ledgerRemainingPaise: paiseOf(4_000),
      statementRemainingPaise: paiseOf(4_000),
    });
    expect(() =>
      payCard(
        {
          occurredOn: isoDate("2026-09-20"),
          capturedAt,
          creditCardId: card.id,
          billingCycleId: cycle.id,
          accountId: hdfc.id,
          amountPaise: paiseOf(4_001),
        },
        snapshotFixture({ accounts: [hdfc], creditCards: [card], billingCycles: [cycle] }),
      ),
    ).toThrow(DomainError);
  });

  it("rejects paying more than ledger-backed liability when the statement is higher", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(50_000) });
    const card = cardFixture();
    const cycle = cycleFixture({
      creditCardId: card.id,
      expectedAmountPaise: paiseOf(10_000),
      actualStatementAmountPaise: paiseOf(10_500),
      ledgerRemainingPaise: paiseOf(10_000),
      statementRemainingPaise: paiseOf(10_500),
      mismatch: true,
    });
    expect(() =>
      payCard(
        {
          occurredOn: isoDate("2026-09-20"),
          capturedAt,
          creditCardId: card.id,
          billingCycleId: cycle.id,
          accountId: hdfc.id,
          amountPaise: paiseOf(10_500),
        },
        snapshotFixture({ accounts: [hdfc], creditCards: [card], billingCycles: [cycle] }),
      ),
    ).toThrow(/ledger-backed card liability/);
  });
});
