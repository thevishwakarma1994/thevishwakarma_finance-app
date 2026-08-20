import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
import { newId } from "../../src/domain/ids.js";
import { recordExpense } from "../../src/domain/commands/recordExpense.js";
import { recordIncome } from "../../src/domain/commands/recordIncome.js";
import { classifyCorrectionCandidate } from "../../src/domain/corrections/eligibility.js";
import { accountFixture, claimFixture, paiseOf, reservationFixture, snapshotFixture } from "./fixtures.js";
import type { FinancialEvent, Posting } from "../../src/domain/ledger/types.js";

const occurredOn = isoDate("2026-08-01");
const capturedAt = "2026-08-01T04:30:00.000Z";

function eventOf(meaning: FinancialEvent["meaning"], overrides: Partial<FinancialEvent> = {}): FinancialEvent {
  return {
    id: overrides.id ?? newId(),
    meaning,
    occurredOn,
    capturedAt,
    amountPaise: overrides.amountPaise ?? paiseOf(500),
    accountId: overrides.accountId ?? null,
    creditCardId: overrides.creditCardId ?? null,
    loanId: null,
    billingCycleId: overrides.billingCycleId ?? null,
    fundingCycleId: overrides.fundingCycleId ?? null,
    obligationInstanceId: overrides.obligationInstanceId ?? null,
    categoryId: overrides.categoryId ?? null,
    channel: null,
    merchant: null,
    notes: null,
    reversalOfEventId: overrides.reversalOfEventId ?? null,
  };
}

describe("correction eligibility", () => {
  it("accepts a normal account-funded expense", () => {
    const account = accountFixture({ balancePaise: paiseOf(50_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    const { batch } = recordExpense(
      {
        occurredOn,
        capturedAt,
        accountId: account.id,
        allocations: [{ categoryId: "cat-grocery", amountPaise: paiseOf(500) }],
      },
      snapshot,
    );
    const result = classifyCorrectionCandidate(batch.events[0]!, {
      ...snapshot,
      events: batch.events,
      postings: batch.postings,
    });
    expect(result).toEqual({ ok: true, family: "expense" });
  });

  it("accepts a normal other-income candidate", () => {
    const account = accountFixture({ balancePaise: paiseOf(10_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    const { batch } = recordIncome(
      {
        occurredOn,
        capturedAt,
        amountPaise: paiseOf(1_000),
        accountId: account.id,
        kind: "other",
      },
      snapshot,
    );
    const result = classifyCorrectionCandidate(batch.events[0]!, {
      ...snapshot,
      events: batch.events,
      postings: batch.postings,
    });
    expect(result).toEqual({ ok: true, family: "other_income" });
  });

  it("rejects salary", () => {
    const account = accountFixture({ balancePaise: paiseOf(10_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    const { batch } = recordIncome(
      {
        occurredOn,
        capturedAt,
        amountPaise: paiseOf(1_000),
        accountId: account.id,
        kind: "salary",
      },
      snapshot,
    );
    const result = classifyCorrectionCandidate(batch.events[0]!, {
      ...snapshot,
      events: batch.events,
      postings: batch.postings,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("salary_income");
  });

  it("rejects card spend", () => {
    const event = eventOf("spend_card", { creditCardId: "card-1" });
    const result = classifyCorrectionCandidate(event, snapshotFixture({ events: [event] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("card_spend");
  });

  it("rejects a split", () => {
    const event = eventOf("split");
    const result = classifyCorrectionCandidate(event, snapshotFixture({ events: [event] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("split");
  });

  it("rejects an opening", () => {
    const event = eventOf("apply_opening_card_position");
    const result = classifyCorrectionCandidate(event, snapshotFixture({ events: [event] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("opening");
  });

  it("rejects a linked claim", () => {
    const account = accountFixture({ balancePaise: paiseOf(50_000) });
    const event = eventOf("lend", { accountId: account.id, id: "lend-1" });
    const claim = claimFixture({ originatingEventId: event.id });
    const postings: Posting[] = [
      {
        id: newId(),
        eventId: event.id,
        amountPaise: paise(-event.amountPaise),
        accountId: account.id,
        creditCardId: null,
        loanId: null,
        pnl: null,
        categoryId: null,
        claimId: null,
        billingCycleId: null,
      },
    ];
    const result = classifyCorrectionCandidate(event, snapshotFixture({
      accounts: [account],
      events: [event],
      postings,
      claims: [claim],
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("linked_claim");
  });

  it("rejects a reservation-linked event", () => {
    const event = eventOf("spend_account", { id: "exp-1", accountId: "acct-1" });
    const result = classifyCorrectionCandidate(
      event,
      snapshotFixture({
        events: [event],
        reservations: [reservationFixture({ originatingEventId: event.id })],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("reservation");
  });
});
