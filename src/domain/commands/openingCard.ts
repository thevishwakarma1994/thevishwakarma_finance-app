import { type Paise, paise } from "../money/paise.js";
import { DomainError, emptyBatch, type LedgerSnapshot, type ProposedBatch, type Posting, type FinancialEvent } from "../ledger/types.js";
import { isoDate } from "../calendar/isoDate.js";
import { resolveBillingCycle } from "../cycle/resolve.js";
import type { BillingCycleRecord } from "../ledger/types.js";

export function applyCardOpening(
  input: {
    commandId: string;
    creditCardId: string;
    billingCycleId?: string;
    amountPaise: Paise;
    occurredOn: string;
    capturedAt: string;
  },
  snapshot: LedgerSnapshot
): ProposedBatch {
  if (input.amountPaise < 0) {
    throw new DomainError("invalid_opening", "Opening amount cannot be negative");
  }

  // Ensure card exists
  const card = snapshot.creditCards.find((c) => c.id === input.creditCardId);
  if (!card) throw new DomainError("not_found", "Card not found");

  let cycle: BillingCycleRecord | undefined = input.billingCycleId 
    ? snapshot.billingCycles.find((c) => c.id === input.billingCycleId)
    : undefined;
  let newCycles: BillingCycleRecord[] | undefined = undefined;
  
  if (!cycle) {
    const cardRule = snapshot.cardRules.find((r) => r.creditCardId === input.creditCardId);
    if (!cardRule) {
       throw new DomainError("not_found", "Card cycle rule not found, cannot materialize cycle");
    }
    const resolved = resolveBillingCycle(input.creditCardId, isoDate(input.occurredOn), cardRule.rule, snapshot.billingCycles);
    cycle = resolved.cycle;
    
    if (input.billingCycleId && resolved.isNew) {
      cycle = { ...cycle, id: input.billingCycleId };
    }
    
    if (resolved.isNew) {
      newCycles = [cycle];
    }
  }

  const finalCycleId = cycle.id;

  if (cycle.creditCardId !== input.creditCardId) {
    throw new DomainError("invalid_opening", "Cycle does not belong to card");
  }

  // Validate uniqueness
  const hasBaseOpening = snapshot.events.some(
    (e) => e.meaning === "apply_opening_card_position" && e.billingCycleId === finalCycleId
  );
  if (hasBaseOpening) {
    throw new DomainError("already_exists", "Opening position already exists for this cycle");
  }

  const event: FinancialEvent = {
    id: input.commandId,
    meaning: "apply_opening_card_position",
    occurredOn: isoDate(input.occurredOn),
    capturedAt: input.capturedAt,
    amountPaise: input.amountPaise,
    accountId: null,
    creditCardId: input.creditCardId,
    billingCycleId: finalCycleId,
    fundingCycleId: null,
    obligationInstanceId: null,
    categoryId: null,
    loanId: null,
    channel: null,
    merchant: "Opening Balance",
    notes: null,
    reversalOfEventId: null,
  };

  const posting: Posting = {
    id: `${input.commandId}_p1`,
    eventId: input.commandId,
    amountPaise: input.amountPaise,
    accountId: null,
    creditCardId: input.creditCardId,
    billingCycleId: finalCycleId,
    pnl: null,
    categoryId: null,
    claimId: null,
    loanId: null,
  };

  return {
    events: [event],
    postings: [posting],
    openings: [],
    billingCycles: newCycles,
  };
}

export function correctCardOpening(
  input: {
    commandId: string;
    creditCardId: string;
    billingCycleId: string;
    targetAmountPaise: Paise;
    occurredOn: string;
    capturedAt: string;
  },
  snapshot: LedgerSnapshot
): ProposedBatch {
  if (input.targetAmountPaise < 0) {
    throw new DomainError("invalid_opening", "Target amount cannot be negative");
  }

  // Ensure cycle exists
  const cycle = snapshot.billingCycles.find((c) => c.id === input.billingCycleId);
  if (!cycle) throw new DomainError("not_found", "Cycle not found");

  // Validate base opening exists
  const baseOpening = snapshot.events.find(
    (e) => e.meaning === "apply_opening_card_position" && e.billingCycleId === input.billingCycleId
  );
  if (!baseOpening) {
    throw new DomainError("invalid_opening", "Cannot correct non-existent opening position");
  }

  // Determine current opening liability by summing base + previous corrections
  const openingEvents = snapshot.events.filter(
    (e) =>
      (e.meaning === "apply_opening_card_position" || e.meaning === "correct_opening_card_position") &&
      e.billingCycleId === input.billingCycleId
  );
  const openingEventIds = new Set(openingEvents.map((e) => e.id));
  
  let currentOpeningLiability = paise(0);
  for (const p of snapshot.postings) {
    if (openingEventIds.has(p.eventId)) {
      currentOpeningLiability = paise(currentOpeningLiability + p.amountPaise);
    }
  }

  // Check for normal lifecycle activity (spend, refund, payment)
  const hasLifecycleActivity = snapshot.events.some(
    (e) =>
      e.billingCycleId === input.billingCycleId &&
      !openingEventIds.has(e.id) && 
      (e.meaning === "spend_card" || e.meaning === "refund" || e.meaning === "pay_obligation" || e.meaning === "split")
  );

  if (hasLifecycleActivity) {
    throw new DomainError(
      "invalid_opening",
      "Cannot correct opening position after normal lifecycle activity has begun"
    );
  }

  const deltaPaise = paise(input.targetAmountPaise - currentOpeningLiability);
  
  if (deltaPaise === 0) {
    return emptyBatch();
  }

  const event: FinancialEvent = {
    id: input.commandId,
    meaning: "correct_opening_card_position",
    occurredOn: isoDate(input.occurredOn),
    capturedAt: input.capturedAt,
    amountPaise: input.targetAmountPaise,
    accountId: null,
    creditCardId: input.creditCardId,
    billingCycleId: input.billingCycleId,
    fundingCycleId: null,
    obligationInstanceId: null,
    categoryId: null,
    loanId: null,
    channel: null,
    merchant: "Opening Balance Correction",
    notes: null,
    reversalOfEventId: null,
  };

  const posting: Posting = {
    id: `${input.commandId}_p1`,
    eventId: input.commandId,
    amountPaise: deltaPaise,
    accountId: null,
    creditCardId: input.creditCardId,
    billingCycleId: input.billingCycleId,
    pnl: null,
    categoryId: null,
    claimId: null,
    loanId: null,
  };

  return {
    events: [event],
    postings: [posting],
    openings: [],
  };
}
