import { paise, type Paise } from "../money/paise.js";
import { utcNowIso } from "../calendar/kolkata.js";
import { applyReservationDelta, reservationsForCycle } from "./derive.js";
import { buildReservationExcess, cycleCardLabel } from "./create.js";
import type {
  LedgerSnapshot,
  ProposedBatch,
  ReservationLedgerEntry,
  ReservationMutation,
  SurplusCaseRecord,
} from "../ledger/types.js";

export function parkCycleReservationExcess(
  snapshot: LedgerSnapshot,
  cycleId: string,
  remainingAfter: Paise,
  capturedAt = utcNowIso(),
): Pick<ProposedBatch, "reservationUpdates" | "reservationLedger" | "surplusCases"> {
  const linked = reservationsForCycle(snapshot.reservations, cycleId)
    .filter((reservation) => reservation.remainingPaise > 0)
    .sort((left, right) => {
      if (left.createdOn === right.createdOn) return left.id.localeCompare(right.id);
      return left.createdOn.localeCompare(right.createdOn);
    });
  const reserved = paise(linked.reduce((sum, reservation) => sum + reservation.remainingPaise, 0));
  let excess = paise(Math.max(0, reserved - remainingAfter));
  const reservationUpdates: ReservationMutation[] = [];
  const reservationLedger: ReservationLedgerEntry[] = [];
  const surplusCases: SurplusCaseRecord[] = [];
  const cycleLabel = cycleCardLabel(snapshot, cycleId);

  for (const reservation of linked) {
    if (excess <= 0) break;
    const take = paise(Math.min(reservation.remainingPaise, excess));
    const eventId = reservation.originatingEventId;
    if (!eventId) continue;
    const mutated = applyReservationDelta(reservation, eventId, capturedAt, { surplusHeld: take });
    reservationUpdates.push(mutated.update);
    reservationLedger.push(mutated.ledger);
    surplusCases.push(
      buildReservationExcess({
        amountPaise: take,
        accountId: reservation.sourceAccountId,
        reservationId: reservation.id,
        eventId,
        cycleLabel,
      }),
    );
    excess = paise(excess - take);
  }

  return { reservationUpdates, reservationLedger, surplusCases };
}
