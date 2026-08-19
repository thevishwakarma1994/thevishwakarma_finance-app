import { describe, it, expect } from "vitest";
import { paise } from "../../src/domain/money/paise.js";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import type {
  EventMeaning,
  FinancialEvent,
  LedgerSnapshot,
  Posting,
} from "../../src/domain/ledger/types.js";
import {
  applyCardOpening,
  correctCardOpening,
  deriveOpeningCardPosition,
} from "../../src/domain/commands/openingCard.js";
import {
  applyClaimOpening,
  correctClaimOpening,
} from "../../src/domain/commands/openingClaim.js";
import {
  cardFixture,
  claimFixture,
  cycleFixture,
  personFixture,
  snapshotFixture,
} from "./fixtures.js";

/**
 * Focused domain units for opening-state derivation. End-to-end lifecycle
 * guarantees are proven by the real application flows in
 * tests/integration/phase16a-lifecycle.test.ts and phase16a-corrections.test.ts.
 */

const CARD_ID = "card-1";
const CYCLE_ID = "cycle-1";
const PERSON_ID = "person-1";
const capturedAt = "2026-08-19T00:00:00.000Z";

function eventFixture(overrides: Partial<FinancialEvent> & { id: string; meaning: EventMeaning }): FinancialEvent {
  return {
    occurredOn: isoDate("2026-08-19"),
    capturedAt,
    amountPaise: paise(0),
    accountId: null,
    creditCardId: null,
    billingCycleId: null,
    fundingCycleId: null,
    obligationInstanceId: null,
    categoryId: null,
    loanId: null,
    channel: null,
    merchant: null,
    notes: null,
    reversalOfEventId: null,
    ...overrides,
  };
}

function postingFixture(overrides: Partial<Posting> & { id: string; eventId: string }): Posting {
  return {
    amountPaise: paise(0),
    accountId: null,
    creditCardId: null,
    billingCycleId: null,
    pnl: null,
    categoryId: null,
    claimId: null,
    loanId: null,
    ...overrides,
  };
}

/** Opening event plus its posting, as the apply/correct commands emit them. */
function openingCardEntries(
  id: string,
  meaning: "apply_opening_card_position" | "correct_opening_card_position",
  eventAmountPaise: number,
  postingAmountPaise: number,
) {
  return {
    event: eventFixture({
      id,
      meaning,
      amountPaise: paise(eventAmountPaise),
      creditCardId: CARD_ID,
      billingCycleId: CYCLE_ID,
    }),
    posting: postingFixture({
      id: `${id}_p1`,
      eventId: id,
      amountPaise: paise(postingAmountPaise),
      creditCardId: CARD_ID,
      billingCycleId: CYCLE_ID,
    }),
  };
}

function cardSnapshot(overrides: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return snapshotFixture({
    creditCards: [cardFixture({ id: CARD_ID })],
    billingCycles: [cycleFixture({ id: CYCLE_ID, creditCardId: CARD_ID })],
    ...overrides,
  });
}

describe("opening card position derivation", () => {
  it("reports no base opening on an untouched cycle", () => {
    const position = deriveOpeningCardPosition(cardSnapshot(), CYCLE_ID);
    expect(position).toEqual({
      baseEventId: null,
      currentEffectiveAmountPaise: 0,
      hasLifecycleActivity: false,
    });
  });

  it("sums posting deltas rather than correction target amounts", () => {
    // Base ₹25,000, corrected to ₹20,000, then to ₹22,000. The correction events
    // each carry a *target*, so summing event amounts would give ₹67,000.
    const base = openingCardEntries("c1", "apply_opening_card_position", 25_000_00, 25_000_00);
    const down = openingCardEntries("c2", "correct_opening_card_position", 20_000_00, -5_000_00);
    const up = openingCardEntries("c3", "correct_opening_card_position", 22_000_00, 2_000_00);
    const snapshot = cardSnapshot({
      events: [base.event, down.event, up.event],
      postings: [base.posting, down.posting, up.posting],
    });

    const position = deriveOpeningCardPosition(snapshot, CYCLE_ID);
    expect(position.baseEventId).toBe("c1");
    expect(position.currentEffectiveAmountPaise).toBe(22_000_00);
    expect(position.hasLifecycleActivity).toBe(false);
  });

  it("flags lifecycle activity only on the cycle that has it", () => {
    const base = openingCardEntries("c1", "apply_opening_card_position", 20_000_00, 20_000_00);
    const spend = eventFixture({
      id: "spend-1",
      meaning: "spend_card",
      amountPaise: paise(1_000_00),
      creditCardId: CARD_ID,
      billingCycleId: "cycle-2",
    });
    const snapshot = cardSnapshot({
      billingCycles: [
        cycleFixture({ id: CYCLE_ID, creditCardId: CARD_ID }),
        cycleFixture({ id: "cycle-2", creditCardId: CARD_ID }),
      ],
      events: [base.event, spend],
      postings: [base.posting],
    });

    expect(deriveOpeningCardPosition(snapshot, CYCLE_ID).hasLifecycleActivity).toBe(false);
    expect(deriveOpeningCardPosition(snapshot, "cycle-2").hasLifecycleActivity).toBe(true);
  });
});

describe("applyCardOpening", () => {
  it("records card liability with no PnL and no account movement", () => {
    const batch = applyCardOpening(
      {
        commandId: "c1",
        creditCardId: CARD_ID,
        billingCycleId: CYCLE_ID,
        amountPaise: paise(20_000_00),
        occurredOn: "2026-08-19",
        capturedAt,
      },
      cardSnapshot(),
    );

    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]!.meaning).toBe("apply_opening_card_position");
    expect(batch.postings).toHaveLength(1);
    expect(batch.postings[0]!.amountPaise).toBe(20_000_00);
    expect(batch.postings[0]!.creditCardId).toBe(CARD_ID);
    expect(batch.postings[0]!.accountId).toBeNull();
    expect(batch.postings[0]!.pnl).toBeNull();
    expect(batch.openings).toHaveLength(0);
  });

  it("rejects a second base opening on the same cycle", () => {
    const base = openingCardEntries("c1", "apply_opening_card_position", 20_000_00, 20_000_00);
    const snapshot = cardSnapshot({ events: [base.event], postings: [base.posting] });

    expect(() =>
      applyCardOpening(
        {
          commandId: "c2",
          creditCardId: CARD_ID,
          billingCycleId: CYCLE_ID,
          amountPaise: paise(5_000_00),
          occurredOn: "2026-08-19",
          capturedAt,
        },
        snapshot,
      ),
    ).toThrow(DomainError);
  });
});

describe("correctCardOpening", () => {
  const base = openingCardEntries("c1", "apply_opening_card_position", 25_000_00, 25_000_00);
  const correctInput = (targetAmountPaise: number) => ({
    commandId: "c2",
    creditCardId: CARD_ID,
    billingCycleId: CYCLE_ID,
    targetAmountPaise: paise(targetAmountPaise),
    occurredOn: "2026-08-19",
    capturedAt,
  });

  it("emits the delta as a posting while the event carries the target", () => {
    const snapshot = cardSnapshot({ events: [base.event], postings: [base.posting] });
    const batch = correctCardOpening(correctInput(20_000_00), snapshot);

    expect(batch.events[0]!.amountPaise).toBe(20_000_00);
    expect(batch.postings[0]!.amountPaise).toBe(-5_000_00);
    expect(batch.postings[0]!.pnl).toBeNull();
    expect(batch.postings[0]!.accountId).toBeNull();
  });

  it("is a no-op when the target already matches the effective amount", () => {
    const snapshot = cardSnapshot({ events: [base.event], postings: [base.posting] });
    const batch = correctCardOpening(correctInput(25_000_00), snapshot);

    expect(batch.events).toHaveLength(0);
    expect(batch.postings).toHaveLength(0);
  });

  it("rejects a correction with no base opening", () => {
    expect(() => correctCardOpening(correctInput(20_000_00), cardSnapshot())).toThrow(
      "Cannot correct non-existent opening position",
    );
  });

  it("locks once normal lifecycle activity has begun on the cycle", () => {
    const spend = eventFixture({
      id: "spend-1",
      meaning: "spend_card",
      amountPaise: paise(1_000_00),
      creditCardId: CARD_ID,
      billingCycleId: CYCLE_ID,
    });
    const snapshot = cardSnapshot({
      events: [base.event, spend],
      postings: [base.posting],
    });

    expect(() => correctCardOpening(correctInput(20_000_00), snapshot)).toThrow(
      "Cannot correct opening position after normal lifecycle activity has begun",
    );
  });
});

describe("opening claims", () => {
  const personSnapshot = (overrides: Partial<LedgerSnapshot> = {}) =>
    snapshotFixture({ people: [personFixture({ id: PERSON_ID })], ...overrides });

  it("creates a claim with no PnL and no account movement", () => {
    const batch = applyClaimOpening(
      {
        commandId: "c3",
        personId: PERSON_ID,
        direction: "they_owe_user",
        amountPaise: paise(10_000_00),
        occurredOn: "2026-08-19",
        capturedAt,
      },
      personSnapshot(),
    );

    expect(batch.claims).toHaveLength(1);
    expect(batch.claims![0]!.originalAmountPaise).toBe(10_000_00);
    expect(batch.postings[0]!.claimId).toBe("c3_claim");
    expect(batch.postings[0]!.pnl).toBeNull();
    expect(batch.postings[0]!.accountId).toBeNull();
    expect(batch.openings).toHaveLength(0);
  });

  it("rejects a second opening in the same direction for one person", () => {
    const apply = eventFixture({ id: "c3", meaning: "apply_opening_claim" });
    const snapshot = personSnapshot({
      events: [apply],
      claims: [
        claimFixture({
          id: "c3_claim",
          personId: PERSON_ID,
          direction: "they_owe_user",
          originatingEventId: "c3",
        }),
      ],
    });

    expect(() =>
      applyClaimOpening(
        {
          commandId: "c4",
          personId: PERSON_ID,
          direction: "they_owe_user",
          amountPaise: paise(1_000_00),
          occurredOn: "2026-08-19",
          capturedAt,
        },
        snapshot,
      ),
    ).toThrow(DomainError);
  });

  it("corrects to a delta and voids the claim when corrected to zero", () => {
    const apply = eventFixture({ id: "c3", meaning: "apply_opening_claim" });
    const applyPosting = postingFixture({
      id: "c3_p1",
      eventId: "c3",
      amountPaise: paise(10_000_00),
      claimId: "c3_claim",
    });
    const snapshot = personSnapshot({
      events: [apply],
      postings: [applyPosting],
      claims: [
        claimFixture({
          id: "c3_claim",
          personId: PERSON_ID,
          direction: "they_owe_user",
          originatingEventId: "c3",
          originalAmountPaise: paise(10_000_00),
        }),
      ],
    });

    const partial = correctClaimOpening(
      { commandId: "c5", claimId: "c3_claim", targetAmountPaise: paise(7_000_00), occurredOn: "2026-08-19", capturedAt },
      snapshot,
    );
    expect(partial.postings[0]!.amountPaise).toBe(-3_000_00);
    expect(partial.claimStatusUpdates ?? []).toHaveLength(0);

    const voided = correctClaimOpening(
      { commandId: "c6", claimId: "c3_claim", targetAmountPaise: paise(0), occurredOn: "2026-08-19", capturedAt },
      snapshot,
    );
    expect(voided.postings[0]!.amountPaise).toBe(-10_000_00);
    expect(voided.claimStatusUpdates).toEqual([{ id: "c3_claim", status: "void" }]);
  });

  it("rejects a correction after settlement activity", () => {
    const apply = eventFixture({ id: "c3", meaning: "apply_opening_claim" });
    const snapshot = personSnapshot({
      events: [apply],
      claims: [
        claimFixture({ id: "c3_claim", personId: PERSON_ID, originatingEventId: "c3" }),
      ],
      settlementAllocations: [
        {
          id: "alloc-1",
          eventId: "settle-1",
          claimId: "c3_claim",
          amountPaise: paise(1_000_00),
          createsReservation: false,
          reservationId: null,
        },
      ],
    });

    expect(() =>
      correctClaimOpening(
        { commandId: "c7", claimId: "c3_claim", targetAmountPaise: paise(0), occurredOn: "2026-08-19", capturedAt },
        snapshot,
      ),
    ).toThrow("Cannot correct opening claim after any settlement activity has occurred");
  });
});
