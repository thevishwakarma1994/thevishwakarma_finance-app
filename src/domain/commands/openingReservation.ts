import { type Paise, paise } from "../money/paise.js";
import { DomainError, emptyBatch, type LedgerSnapshot, type ProposedBatch, type FinancialEvent, type ReservationRecord, type ReservationMutation, type ReservationLedgerEntry, type BillingCycleRecord } from "../ledger/types.js";
import { isoDate } from "../calendar/isoDate.js";
import { accountAvailability } from "../engine/liquidity.js";
import { enrichReservation, applyReservationDelta } from "../reservations/derive.js";
import { resolveBillingCycle } from "../cycle/resolve.js";


export function applyReservationOpening(
  input: {
    commandId: string;
    sourceAccountId: string;
    cardId: string;
    billingCycleId: string;
    amountPaise: Paise;
    occurredOn: string;
    capturedAt: string;
  },
  snapshot: LedgerSnapshot
): ProposedBatch {
  if (input.amountPaise <= 0) {
    throw new DomainError("invalid_opening", "Opening reservation amount must be positive");
  }

  // Ensure account exists
  const account = snapshot.accounts.find((a) => a.id === input.sourceAccountId);
  if (!account) throw new DomainError("not_found", "Account not found");

  // Ensure cycle exists
  let cycle: BillingCycleRecord | undefined = snapshot.billingCycles.find((c) => c.id === input.billingCycleId);
  let newCycles: BillingCycleRecord[] | undefined = undefined;

  if (!cycle) {
    if (!input.cardId) throw new DomainError("invalid_opening", "Card ID required to materialize cycle");
    const cardRule = snapshot.cardRules.find((r) => r.creditCardId === input.cardId);
    if (!cardRule) {
       throw new DomainError("not_found", "Card cycle rule not found, cannot materialize cycle");
    }
    const resolved = resolveBillingCycle(input.cardId, isoDate(input.occurredOn), cardRule.rule, snapshot.billingCycles);
    cycle = {
      ...resolved.cycle,
      id: input.billingCycleId,
    };
    newCycles = [cycle];
  }

  // Validate uniqueness
  const hasBaseOpening = snapshot.events.some(
    (e) => e.meaning === "apply_opening_reservation" &&
      snapshot.reservations.some(r => r.originatingEventId === e.id && r.obligationRef.id === input.billingCycleId)
  );
  if (hasBaseOpening) {
    throw new DomainError("already_exists", "Opening reservation already exists for this cycle");
  }

  // Validate account availability
  const availability = accountAvailability(snapshot, input.sourceAccountId);
  if (availability.availablePaise < input.amountPaise) {
    throw new DomainError("insufficient_funds", "Insufficient available funds for opening reservation");
  }

  const event: FinancialEvent = {
    id: input.commandId,
    meaning: "apply_opening_reservation",
    occurredOn: isoDate(input.occurredOn),
    capturedAt: input.capturedAt,
    amountPaise: input.amountPaise,
    accountId: input.sourceAccountId,
    creditCardId: null,
    billingCycleId: null,
    fundingCycleId: null,
    obligationInstanceId: null,
    categoryId: null,
    loanId: null,
    channel: null,
    merchant: "Opening Reservation",
    notes: null,
    reversalOfEventId: null,
  };

  const reservationId = `${input.commandId}_res`;
  
  const reservationRecord: ReservationRecord = {
    id: reservationId,
    sourceAccountId: input.sourceAccountId,
    amountOriginalPaise: input.amountPaise,
    amountConsumedPaise: paise(0),
    amountReleasedPaise: paise(0),
    amountReassignedPaise: paise(0),
    amountSurplusHeldPaise: paise(0),
    status: "active",
    obligationRef: { type: "billing_cycle", id: input.billingCycleId },
    originatingEventId: event.id,
    originatingClaimId: null,
    createdOn: isoDate(input.occurredOn),
  };

  return {
    events: [event],
    postings: [],
    reservations: [reservationRecord],
    reservationUpdates: [],
    reservationLedger: [],
    openings: [],
    billingCycles: newCycles,
  };
}

export function correctReservationOpening(
  input: {
    commandId: string;
    reservationId: string;
    targetAmountPaise: Paise;
    occurredOn: string;
    capturedAt: string;
  },
  snapshot: LedgerSnapshot
): ProposedBatch {
  if (input.targetAmountPaise < 0) {
    throw new DomainError("invalid_opening", "Target reservation amount cannot be negative");
  }

  // Ensure reservation exists
  const reservationRecord = snapshot.reservations.find((r) => r.id === input.reservationId);
  if (!reservationRecord) throw new DomainError("not_found", "Reservation not found");

  // Validate it's an opening reservation
  const baseOpening = snapshot.events.find(
    (e) => (e.meaning === "apply_opening_reservation" || e.meaning === "correct_opening_reservation") && e.id === reservationRecord.originatingEventId
  );
  if (!baseOpening) {
    throw new DomainError("invalid_opening", "Cannot correct a non-opening reservation");
  }

  // Validate no lifecycle activity has occurred
  if (
    reservationRecord.amountConsumedPaise > 0 ||
    reservationRecord.amountReleasedPaise > 0 ||
    reservationRecord.amountReassignedPaise > 0 ||
    reservationRecord.amountSurplusHeldPaise > 0 ||
    reservationRecord.status !== "active"
  ) {
    throw new DomainError(
      "invalid_opening",
      "Cannot correct opening reservation after normal lifecycle activity has begun"
    );
  }

  if (reservationRecord.amountOriginalPaise === input.targetAmountPaise) {
    return emptyBatch();
  }

  const reservation = enrichReservation(reservationRecord);
  const remainingPaise = reservation.remainingPaise;

  const event: FinancialEvent = {
    id: input.commandId,
    meaning: "correct_opening_reservation",
    occurredOn: isoDate(input.occurredOn),
    capturedAt: input.capturedAt,
    amountPaise: input.targetAmountPaise,
    accountId: reservation.sourceAccountId,
    creditCardId: null,
    billingCycleId: null,
    fundingCycleId: null,
    obligationInstanceId: null,
    categoryId: null,
    loanId: null,
    channel: null,
    merchant: "Opening Reservation Correction",
    notes: null,
    reversalOfEventId: null,
  };

  const reservationsToCreate: ReservationRecord[] = [];
  const reservationUpdates: ReservationMutation[] = [];
  const reservationLedgers: ReservationLedgerEntry[] = [];

  // 1. Release the entire old reservation
  const { update: releaseUpdate, ledger: releaseLedger } = applyReservationDelta(
    reservation,
    event.id,
    input.capturedAt,
    { released: remainingPaise }
  );

  reservationUpdates.push(releaseUpdate);
  reservationLedgers.push(releaseLedger);

  // 2. Determine new availability for the replacement
  // We compute the availability assuming the old one is released.
  // We can just add the released amount to the current available amount.
  const currentAvailability = accountAvailability(snapshot, reservation.sourceAccountId);
  const newAvailablePaise = currentAvailability.availablePaise + remainingPaise;

  if (input.targetAmountPaise > 0) {
    if (newAvailablePaise < input.targetAmountPaise) {
      throw new DomainError("insufficient_funds", "Insufficient available funds for corrected reservation amount");
    }

    const replacementId = `${input.commandId}_res`;
    const replacementRecord: ReservationRecord = {
      id: replacementId,
      sourceAccountId: reservation.sourceAccountId,
      amountOriginalPaise: input.targetAmountPaise,
      amountConsumedPaise: paise(0),
      amountReleasedPaise: paise(0),
      amountReassignedPaise: paise(0),
      amountSurplusHeldPaise: paise(0),
      status: "active",
      obligationRef: reservation.obligationRef,
      originatingEventId: event.id,
      originatingClaimId: null,
      createdOn: isoDate(input.occurredOn),
    };
    reservationsToCreate.push(replacementRecord);
  }

  return {
    events: [event],
    postings: [],
    reservations: reservationsToCreate,
    reservationUpdates,
    reservationLedger: reservationLedgers,
    openings: [],
  };
}
