import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
import { newId } from "../../src/domain/ids.js";
import { enrichBillingCycle, obligationRemainingForSTS, paymentCap } from "../../src/domain/cycle/lifecycle.js";
import type { BillingCycleRecord, FinancialEvent, Posting } from "../../src/domain/ledger/types.js";
import { paiseOf } from "./fixtures.js";

const cycle: BillingCycleRecord = {
  id: "cycle-1",
  creditCardId: "card-1",
  purchaseWindowStart: isoDate("2026-08-13"),
  purchaseWindowEnd: isoDate("2026-09-12"),
  expectedStatementOn: isoDate("2026-09-12"),
  actualStatementOn: null,
  expectedDueOn: isoDate("2026-09-30"),
  actualDueOn: null,
  actualStatementAmountPaise: null,
  ruleSnapshot: { statementDay: 12, dueDaysAfterStatement: 18 },
};

function cardPosting(eventId: string, amount: number, meaningPaid = false): { event: FinancialEvent; posting: Posting } {
  const event: FinancialEvent = {
    id: eventId,
    meaning: meaningPaid ? "pay_obligation" : "spend_card",
    occurredOn: isoDate("2026-08-20"),
    capturedAt: "2026-08-20T04:30:00.000Z",
    amountPaise: paise(Math.abs(amount)),
    accountId: meaningPaid ? "acct-1" : null,
    creditCardId: "card-1",
    loanId: null,
    billingCycleId: cycle.id,
    fundingCycleId: null,
    categoryId: null,
    channel: null,
    merchant: null,
    notes: null,
    reversalOfEventId: null,
  };
  const posting: Posting = {
    id: newId(),
    eventId,
    amountPaise: paise(amount),
    accountId: null,
    creditCardId: "card-1",
    loanId: null,
    pnl: null,
    categoryId: null,
    claimId: null,
    billingCycleId: cycle.id,
  };
  return { event, posting };
}

describe("cycle remaining derivation", () => {
  it("treats any non-payment cycle-linked card posting as expected activity", () => {
    const spend = cardPosting("e-spend", 1_000_000);
    const refundLike: FinancialEvent = {
      ...spend.event,
      id: "e-refund",
      meaning: "refund",
      amountPaise: paiseOf(500),
    };
    const refundPosting: Posting = {
      ...spend.posting,
      id: newId(),
      eventId: "e-refund",
      amountPaise: paise(-50_000),
    };
    const enriched = enrichBillingCycle(
      cycle,
      [spend.event, refundLike],
      [spend.posting, refundPosting],
      isoDate("2026-08-20"),
    );
    expect(enriched.expectedAmountPaise).toBe(950_000);
    expect(enriched.ledgerRemainingPaise).toBe(950_000);
    expect(enriched.statementRemainingPaise).toBe(950_000);
  });

  it("keeps ledger and statement remainings distinct after a mismatched actual", () => {
    const spend = cardPosting("e-spend", 1_000_000);
    const enriched = enrichBillingCycle(
      {
        ...cycle,
        actualStatementAmountPaise: paiseOf(10_500),
        actualStatementOn: isoDate("2026-09-12"),
      },
      [spend.event],
      [spend.posting],
      isoDate("2026-09-12"),
    );
    expect(enriched.expectedAmountPaise).toBe(1_000_000);
    expect(enriched.ledgerRemainingPaise).toBe(1_000_000);
    expect(enriched.statementRemainingPaise).toBe(1_050_000);
    expect(enriched.remainingPaise).toBe(1_000_000);
    expect(enriched.obligationRemainingForSTS).toBe(1_050_000);
    expect(enriched.mismatch).toBe(true);
    expect(enriched.lifecycle).not.toBe("paid");
  });

  it("does not mark paid when statement remaining is zero but ledger remaining is not", () => {
    const spend = cardPosting("e-spend", 1_000_000);
    const pay = cardPosting("e-pay", -950_000, true);
    const enriched = enrichBillingCycle(
      {
        ...cycle,
        actualStatementAmountPaise: paiseOf(9_500),
        actualStatementOn: isoDate("2026-09-12"),
      },
      [spend.event, pay.event],
      [spend.posting, pay.posting],
      isoDate("2026-09-20"),
    );
    expect(enriched.statementRemainingPaise).toBe(0);
    expect(enriched.ledgerRemainingPaise).toBe(50_000);
    expect(enriched.remainingPaise).toBe(0);
    expect(enriched.obligationRemainingForSTS).toBe(50_000);
    expect(enriched.mismatch).toBe(true);
    expect(enriched.status).not.toBe("paid");
    expect(enriched.lifecycle).not.toBe("paid");
  });
});

describe("payment cap vs STS obligation", () => {
  it("keeps paymentCap as min and STS obligation as max", () => {
    expect(paymentCap(paiseOf(10_000), paiseOf(10_500))).toBe(paiseOf(10_000));
    expect(obligationRemainingForSTS(paiseOf(10_000), paiseOf(10_500))).toBe(paiseOf(10_500));
    expect(paymentCap(paiseOf(10_000), paiseOf(9_500))).toBe(paiseOf(9_500));
    expect(obligationRemainingForSTS(paiseOf(10_000), paiseOf(9_500))).toBe(paiseOf(10_000));
    expect(paymentCap(paiseOf(10_000), paiseOf(10_000))).toBe(paiseOf(10_000));
    expect(obligationRemainingForSTS(paiseOf(10_000), paiseOf(10_000))).toBe(paiseOf(10_000));
  });
});
