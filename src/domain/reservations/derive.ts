import { paise, type Paise } from "../money/paise.js";
import { newId } from "../ids.js";
import { DomainError } from "../ledger/types.js";
import type {
  LedgerReservation,
  ReservationLedgerEntry,
  ReservationMutation,
  ReservationRecord,
  ReservationStatus,
} from "../ledger/types.js";

export function remainingOf(
  reservation: Pick<
    ReservationRecord,
    | "amountOriginalPaise"
    | "amountConsumedPaise"
    | "amountReleasedPaise"
    | "amountReassignedPaise"
    | "amountSurplusHeldPaise"
  >,
): Paise {
  const remaining =
    reservation.amountOriginalPaise -
    reservation.amountConsumedPaise -
    reservation.amountReleasedPaise -
    reservation.amountReassignedPaise -
    reservation.amountSurplusHeldPaise;
  if (remaining < 0) {
    throw new DomainError("invalid_reservation", "Reservation remaining cannot be negative");
  }
  return paise(remaining);
}

export function deriveReservationStatus(reservation: ReservationRecord): ReservationStatus {
  const remaining = remainingOf(reservation);
  if (remaining > 0) return "active";
  if (reservation.amountSurplusHeldPaise > 0) return "surplus_pending";
  if (
    reservation.amountReassignedPaise > 0 &&
    reservation.amountConsumedPaise === 0 &&
    reservation.amountReleasedPaise === 0
  ) {
    return "reassigned";
  }
  if (reservation.amountReleasedPaise > 0 && reservation.amountConsumedPaise === 0) {
    return "released";
  }
  return "consumed";
}

export function enrichReservation(reservation: ReservationRecord): LedgerReservation {
  const remainingPaise = remainingOf(reservation);
  return {
    ...reservation,
    status: deriveReservationStatus(reservation),
    remainingPaise,
  };
}

export function applyReservationDelta(
  reservation: LedgerReservation,
  eventId: string,
  createdAt: string,
  delta: {
    consumed?: Paise;
    released?: Paise;
    reassigned?: Paise;
    surplusHeld?: Paise;
  },
): { next: LedgerReservation; ledger: ReservationLedgerEntry; update: ReservationMutation } {
  const consumed = delta.consumed ?? paise(0);
  const released = delta.released ?? paise(0);
  const reassigned = delta.reassigned ?? paise(0);
  const surplusHeld = delta.surplusHeld ?? paise(0);
  if (consumed < 0 || released < 0 || reassigned < 0) {
    throw new DomainError("invalid_reservation", "Reservation deltas cannot be negative");
  }
  if (consumed + released + reassigned === 0 && surplusHeld === 0) {
    throw new DomainError("invalid_reservation", "Reservation mutation must change an amount");
  }
  const nextSurplusHeld = reservation.amountSurplusHeldPaise + surplusHeld;
  if (nextSurplusHeld < 0) {
    throw new DomainError("invalid_reservation", "Reservation remaining cannot be negative");
  }
  const nextRecord: ReservationRecord = {
    ...reservation,
    amountConsumedPaise: paise(reservation.amountConsumedPaise + consumed),
    amountReleasedPaise: paise(reservation.amountReleasedPaise + released),
    amountReassignedPaise: paise(reservation.amountReassignedPaise + reassigned),
    amountSurplusHeldPaise: paise(nextSurplusHeld),
  };
  const next = enrichReservation(nextRecord);
  return {
    next,
    ledger: {
      id: newId(),
      reservationId: reservation.id,
      eventId,
      deltaConsumedPaise: consumed,
      deltaReleasedPaise: released,
      deltaReassignedPaise: reassigned,
      deltaSurplusHeldPaise: surplusHeld,
      createdAt,
    },
    update: {
      id: reservation.id,
      amountConsumedPaise: next.amountConsumedPaise,
      amountReleasedPaise: next.amountReleasedPaise,
      amountReassignedPaise: next.amountReassignedPaise,
      amountSurplusHeldPaise: next.amountSurplusHeldPaise,
      status: next.status,
    },
  };
}

export function reservationsForRef(
  reservations: LedgerReservation[],
  ref: { type: LedgerReservation["obligationRef"]["type"]; id: string },
): LedgerReservation[] {
  return reservations.filter(
    (reservation) =>
      reservation.obligationRef.type === ref.type && reservation.obligationRef.id === ref.id,
  );
}

export function reservedToward(
  reservations: LedgerReservation[],
  ref: { type: LedgerReservation["obligationRef"]["type"]; id: string },
): Paise {
  return paise(
    reservationsForRef(reservations, ref).reduce((sum, reservation) => sum + reservation.remainingPaise, 0),
  );
}

export function reservationsForCycle(
  reservations: LedgerReservation[],
  cycleId: string,
): LedgerReservation[] {
  return reservationsForRef(reservations, { type: "billing_cycle", id: cycleId });
}

export function reservedTowardCycle(reservations: LedgerReservation[], cycleId: string): Paise {
  return reservedToward(reservations, { type: "billing_cycle", id: cycleId });
}
