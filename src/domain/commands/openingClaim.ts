import { type Paise, paise } from "../money/paise.js";
import { DomainError, emptyBatch, type LedgerSnapshot, type ProposedBatch, type Posting, type FinancialEvent, type ClaimRecord } from "../ledger/types.js";
import { isoDate } from "../calendar/isoDate.js";

export function applyClaimOpening(
  input: {
    commandId: string;
    personId: string;
    direction: "they_owe_user" | "user_owes_them";
    amountPaise: Paise;
    occurredOn: string;
    capturedAt: string;
  },
  snapshot: LedgerSnapshot
): ProposedBatch {
  if (input.amountPaise <= 0) {
    throw new DomainError("invalid_opening", "Opening amount must be positive");
  }

  // Ensure person exists
  const person = snapshot.people.find((p) => p.id === input.personId);
  if (!person) throw new DomainError("not_found", "Person not found");

  // Validate uniqueness (only one base opening per person/direction)
  const hasBaseOpening = snapshot.events.some(
    (e) => e.meaning === "apply_opening_claim" && 
    snapshot.claims.some(c => c.originatingEventId === e.id && c.personId === input.personId && c.direction === input.direction)
  );
  if (hasBaseOpening) {
    throw new DomainError("already_exists", `An opening ${input.direction} already exists for this person`);
  }

  const event: FinancialEvent = {
    id: input.commandId,
    meaning: "apply_opening_claim",
    occurredOn: isoDate(input.occurredOn),
    capturedAt: input.capturedAt,
    amountPaise: input.amountPaise,
    accountId: null,
    creditCardId: null,
    billingCycleId: null,
    fundingCycleId: null,
    obligationInstanceId: null,
    categoryId: null,
    loanId: null,
    channel: null,
    merchant: "Opening Balance",
    notes: null,
    reversalOfEventId: null,
  };
  
  const claimId = `${input.commandId}_claim`;

  const claim: ClaimRecord = {
    id: claimId,
    personId: input.personId,
    direction: input.direction,
    kind: input.direction === "they_owe_user" ? "direct_loan" : "borrowing",
    originalAmountPaise: input.amountPaise,
    originatingEventId: event.id,
    openingPositionId: null,
    billingCycleId: null,
    note: "Opening Balance",
    status: "open",
  };

  const posting: Posting = {
    id: `${input.commandId}_p1`,
    eventId: input.commandId,
    amountPaise: input.amountPaise,
    accountId: null,
    creditCardId: null,
    billingCycleId: null,
    pnl: null,
    categoryId: null,
    claimId: claim.id,
    loanId: null,
  };

  return {
    events: [event],
    postings: [posting],
    openings: [],
    claims: [claim],
  };
}

export function correctClaimOpening(
  input: {
    commandId: string;
    claimId: string;
    targetAmountPaise: Paise;
    occurredOn: string;
    capturedAt: string;
  },
  snapshot: LedgerSnapshot
): ProposedBatch {
  if (input.targetAmountPaise < 0) {
    throw new DomainError("invalid_opening", "Target amount cannot be negative");
  }

  // Ensure claim exists
  const claim = snapshot.claims.find((c) => c.id === input.claimId);
  if (!claim) throw new DomainError("not_found", "Claim not found");

  // Validate it's an opening claim
  const baseOpening = snapshot.events.find(
    (e) => e.meaning === "apply_opening_claim" && e.id === claim.originatingEventId
  );
  if (!baseOpening) {
    throw new DomainError("invalid_opening", "Cannot correct a non-opening claim");
  }

  // Check for settlement locks (no settlement allocations allowed)
  const hasSettlements = snapshot.settlementAllocations.some((s) => s.claimId === input.claimId);
  if (hasSettlements) {
    throw new DomainError(
      "invalid_opening",
      "Cannot correct opening claim after any settlement activity has occurred"
    );
  }

  // Determine current opening balance by summing base + previous corrections
  const openingEvents = snapshot.events.filter(
    (e) => e.meaning === "apply_opening_claim" || e.meaning === "correct_opening_claim"
  );
  const openingEventIds = new Set(openingEvents.map((e) => e.id));
  
  let currentOpeningBalance = paise(0);
  for (const p of snapshot.postings) {
    if (p.claimId === input.claimId && openingEventIds.has(p.eventId)) {
      currentOpeningBalance = paise(currentOpeningBalance + p.amountPaise);
    }
  }

  const deltaPaise = paise(input.targetAmountPaise - currentOpeningBalance);
  
  if (deltaPaise === 0) {
    return emptyBatch();
  }

  const event: FinancialEvent = {
    id: input.commandId,
    meaning: "correct_opening_claim",
    occurredOn: isoDate(input.occurredOn),
    capturedAt: input.capturedAt,
    amountPaise: input.targetAmountPaise,
    accountId: null,
    creditCardId: null,
    billingCycleId: null,
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
    creditCardId: null,
    billingCycleId: null,
    pnl: null,
    categoryId: null,
    claimId: input.claimId,
    loanId: null,
  };

  return {
    events: [event],
    postings: [posting],
    claimStatusUpdates:
      claim.openAmountPaise + deltaPaise <= 0 ? [{ id: claim.id, status: "void" as const }] : [],
    openings: [],
  };
}
