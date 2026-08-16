import { paise, type Paise } from "../money/paise.js";
import { formatInr } from "../money/inr.js";
import { newId } from "../ids.js";
import { formatCardLabel } from "../cycle/lifecycle.js";
import { reservedTowardCycle } from "../reservations/derive.js";
import type {
  LedgerClaim,
  LedgerSnapshot,
  ReservationRecord,
  SurplusCaseRecord,
} from "../ledger/types.js";

export function unfundedForCycle(snapshot: LedgerSnapshot, cycleId: string): Paise {
  const cycle = snapshot.billingCycles.find((item) => item.id === cycleId);
  if (!cycle) return paise(0);
  const reserved = reservedTowardCycle(snapshot.reservations, cycleId);
  return paise(Math.max(0, cycle.remainingPaise - reserved));
}

export function obligationForCardLinkedClaim(
  snapshot: LedgerSnapshot,
  claim: LedgerClaim,
): { type: "billing_cycle"; id: string } | null {
  if (!claim.billingCycleId) return null;
  if (claim.kind !== "card_share" && claim.kind !== "shared_bill") return null;
  const cycle = snapshot.billingCycles.find((item) => item.id === claim.billingCycleId);
  if (!cycle) return null;
  return { type: "billing_cycle", id: cycle.id };
}

export function reservationAmountForAllocation(
  snapshot: LedgerSnapshot,
  claim: LedgerClaim,
  allocationPaise: Paise,
  reservedThisBatchByCycle: Map<string, Paise>,
): Paise {
  const obligation = obligationForCardLinkedClaim(snapshot, claim);
  if (!obligation) return paise(0);
  const already =
    reservedTowardCycle(snapshot.reservations, obligation.id) +
    (reservedThisBatchByCycle.get(obligation.id) ?? paise(0));
  const cycle = snapshot.billingCycles.find((item) => item.id === obligation.id);
  if (!cycle || cycle.remainingPaise <= 0) return paise(0);
  const needed = paise(Math.max(0, cycle.remainingPaise - already));
  return paise(Math.min(allocationPaise, needed));
}

export function buildReservation(input: {
  sourceAccountId: string;
  amountPaise: Paise;
  obligation: { type: "billing_cycle"; id: string };
  originatingEventId: string;
  originatingClaimId: string | null;
  createdOn: ReservationRecord["createdOn"];
}): ReservationRecord {
  return {
    id: newId(),
    sourceAccountId: input.sourceAccountId,
    amountOriginalPaise: input.amountPaise,
    amountConsumedPaise: paise(0),
    amountReleasedPaise: paise(0),
    amountReassignedPaise: paise(0),
    amountSurplusHeldPaise: paise(0),
    status: "active",
    obligationRef: input.obligation,
    originatingEventId: input.originatingEventId,
    originatingClaimId: input.originatingClaimId,
    createdOn: input.createdOn,
  };
}

export function cycleCardLabel(snapshot: LedgerSnapshot, cycleId: string): string {
  const cycle = snapshot.billingCycles.find((item) => item.id === cycleId);
  const card = cycle
    ? snapshot.creditCards.find((item) => item.id === cycle.creditCardId)
    : undefined;
  return card ? formatCardLabel(card.displayName, card.mask) : "card cycle";
}

export function buildUnallocatedSurplus(input: {
  amountPaise: Paise;
  accountId: string | null;
  personId: string;
  eventId: string;
  personName: string;
  cashSittingInAccount: boolean;
}): SurplusCaseRecord {
  const explanation = input.cashSittingInAccount
    ? `${input.personName} sent ${formatInr(input.amountPaise)} that is not applied to a claim.`
    : `Payment to ${input.personName} includes ${formatInr(input.amountPaise)} that is not applied to a claim.`;
  return {
    id: newId(),
    amountPaise: input.amountPaise,
    kind: "unallocated_settlement",
    sourceAccountId: input.cashSittingInAccount ? input.accountId : null,
    personId: input.personId,
    reservationId: null,
    eventId: input.eventId,
    explanation,
    status: "pending",
    resolution: null,
    resolvedAt: null,
    resolvedByEventId: null,
  };
}

export function buildReservationExcess(input: {
  amountPaise: Paise;
  accountId: string;
  reservationId: string;
  eventId: string;
  cycleLabel: string;
}): SurplusCaseRecord {
  return {
    id: newId(),
    amountPaise: input.amountPaise,
    kind: "reservation_excess",
    sourceAccountId: input.accountId,
    personId: null,
    reservationId: input.reservationId,
    eventId: input.eventId,
    explanation: `Reserved money for ${input.cycleLabel} is ${formatInr(input.amountPaise)} more than the remaining obligation.`,
    status: "pending",
    resolution: null,
    resolvedAt: null,
    resolvedByEventId: null,
  };
}
