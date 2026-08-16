import { paise } from "../money/paise.js";
import { formatInr, formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import { formatCardLabel, payablePaise } from "../cycle/lifecycle.js";
import { accountAvailability } from "../engine/liquidity.js";
import {
  applyReservationDelta,
  reservationsForCycle,
} from "../reservations/derive.js";
import {
  buildReservationExcess,
  cycleCardLabel,
} from "../reservations/create.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { Paise } from "../money/paise.js";
import {
  DomainError,
  type ConsequencePreview,
  type FinancialEvent,
  type LedgerReservation,
  type LedgerSnapshot,
  type Posting,
  type ProposedBatch,
  type ReservationLedgerEntry,
  type ReservationMutation,
  type SurplusCaseRecord,
} from "../ledger/types.js";

export type PayCardInput = {
  occurredOn: IsoDate;
  capturedAt: string;
  creditCardId: string;
  billingCycleId: string;
  accountId: string;
  amountPaise: Paise;
  notes?: string | null;
  channel?: string | null;
};

function byCreatedThenId(left: LedgerReservation, right: LedgerReservation): number {
  if (left.createdOn === right.createdOn) return left.id.localeCompare(right.id);
  return left.createdOn.localeCompare(right.createdOn);
}

export function payCard(
  input: PayCardInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  if (input.amountPaise <= 0) {
    throw new DomainError("invalid_amount", "Payment amount must be greater than zero");
  }

  const card = snapshot.creditCards.find((item) => item.id === input.creditCardId);
  if (!card) {
    throw new DomainError("card_not_found", "Credit card not found");
  }

  const cycle = snapshot.billingCycles.find(
    (item) => item.id === input.billingCycleId && item.creditCardId === card.id,
  );
  if (!cycle) {
    throw new DomainError("cycle_not_found", "Billing cycle not found");
  }

  const account = snapshot.accounts.find((item) => item.id === input.accountId);
  if (!account || account.status !== "active") {
    throw new DomainError("account_not_found", "Payment account not found");
  }

  const payable = payablePaise(cycle.ledgerRemainingPaise, cycle.statementRemainingPaise);
  if (input.amountPaise > payable || input.amountPaise > cycle.ledgerRemainingPaise) {
    throw new DomainError(
      "payment_exceeds_outstanding",
      cycle.mismatch
        ? "Payment cannot exceed ledger-backed card liability while a statement mismatch is unresolved"
        : "Payment cannot exceed outstanding issuer liability",
    );
  }

  const linked = reservationsForCycle(snapshot.reservations, cycle.id);
  const linkedHere = linked
    .filter((reservation) => reservation.sourceAccountId === account.id && reservation.remainingPaise > 0)
    .sort(byCreatedThenId);
  const linkedRemaining = paise(
    linkedHere.reduce((sum, reservation) => sum + reservation.remainingPaise, 0),
  );
  const availability = accountAvailability(snapshot, account.id);
  const usable = paise(availability.availablePaise + linkedRemaining);
  if (input.amountPaise > usable) {
    throw new DomainError(
      "insufficient_available",
      "This payment exceeds available money plus the reservation for this cycle",
    );
  }
  if (input.amountPaise > account.balancePaise) {
    throw new DomainError(
      "insufficient_balance",
      "This payment exceeds the money currently in the account",
    );
  }

  const eventId = newId();
  const label = formatCardLabel(card.displayName, card.mask);
  const cycleLabel = cycleCardLabel(snapshot, cycle.id);

  const event: FinancialEvent = {
    id: eventId,
    meaning: "pay_obligation",
    occurredOn: input.occurredOn,
    capturedAt: input.capturedAt,
    amountPaise: input.amountPaise,
    accountId: account.id,
    creditCardId: card.id,
    loanId: null,
    billingCycleId: cycle.id,
    fundingCycleId: null,
    categoryId: null,
    channel: input.channel ?? null,
    merchant: null,
    notes: input.notes ?? null,
    reversalOfEventId: null,
  };

  const postings: Posting[] = [
    {
      id: newId(),
      eventId,
      amountPaise: paise(-input.amountPaise),
      accountId: account.id,
      creditCardId: null,
      loanId: null,
      pnl: null,
      categoryId: null,
      claimId: null,
      billingCycleId: cycle.id,
    },
    {
      id: newId(),
      eventId,
      amountPaise: paise(-input.amountPaise),
      accountId: null,
      creditCardId: card.id,
      loanId: null,
      pnl: null,
      categoryId: null,
      claimId: null,
      billingCycleId: cycle.id,
    },
  ];

  const working = new Map(snapshot.reservations.map((reservation) => [reservation.id, reservation]));
  const reservationUpdates: ReservationMutation[] = [];
  const reservationLedger: ReservationLedgerEntry[] = [];
  const surplusCases: SurplusCaseRecord[] = [];
  let consumedTotal = paise(0);

  let toConsume = paise(Math.min(input.amountPaise, linkedRemaining));
  for (const reservation of linkedHere) {
    if (toConsume <= 0) break;
    const current = working.get(reservation.id);
    if (!current || current.remainingPaise <= 0) continue;
    const take = paise(Math.min(current.remainingPaise, toConsume));
    const mutated = applyReservationDelta(current, eventId, input.capturedAt, { consumed: take });
    working.set(reservation.id, mutated.next);
    reservationUpdates.push(mutated.update);
    reservationLedger.push(mutated.ledger);
    consumedTotal = paise(consumedTotal + take);
    toConsume = paise(toConsume - take);
  }

  const remainingAfter = paise(cycle.remainingPaise - input.amountPaise);
  const leftoverPaying = paise(
    [...working.values()]
      .filter(
        (reservation) =>
          reservation.obligationRef.type === "billing_cycle" &&
          reservation.obligationRef.id === cycle.id &&
          reservation.sourceAccountId === account.id,
      )
      .reduce((sum, reservation) => sum + reservation.remainingPaise, 0),
  );
  const keepOnPaying = paise(Math.min(leftoverPaying, remainingAfter));
  let surplusOnPaying = paise(leftoverPaying - keepOnPaying);
  const neededFromOthers = paise(Math.max(0, remainingAfter - keepOnPaying));
  const others = [...working.values()]
    .filter(
      (reservation) =>
        reservation.obligationRef.type === "billing_cycle" &&
        reservation.obligationRef.id === cycle.id &&
        reservation.sourceAccountId !== account.id &&
        reservation.remainingPaise > 0,
    )
    .sort(byCreatedThenId);
  const othersRemaining = paise(
    others.reduce((sum, reservation) => sum + reservation.remainingPaise, 0),
  );
  let toRelease = paise(Math.max(0, othersRemaining - neededFromOthers));

  for (const reservation of others) {
    if (toRelease <= 0) break;
    const current = working.get(reservation.id);
    if (!current || current.remainingPaise <= 0) continue;
    const take = paise(Math.min(current.remainingPaise, toRelease));
    const mutated = applyReservationDelta(current, eventId, input.capturedAt, { released: take });
    working.set(reservation.id, mutated.next);
    reservationUpdates.push(mutated.update);
    reservationLedger.push(mutated.ledger);
    toRelease = paise(toRelease - take);
  }

  if (surplusOnPaying > 0) {
    const payingLeftovers = [...working.values()]
      .filter(
        (reservation) =>
          reservation.obligationRef.type === "billing_cycle" &&
          reservation.obligationRef.id === cycle.id &&
          reservation.sourceAccountId === account.id &&
          reservation.remainingPaise > 0,
      )
      .sort(byCreatedThenId);
    for (const reservation of payingLeftovers) {
      if (surplusOnPaying <= 0) break;
      const current = working.get(reservation.id);
      if (!current || current.remainingPaise <= 0) continue;
      const take = paise(Math.min(current.remainingPaise, surplusOnPaying));
      const mutated = applyReservationDelta(current, eventId, input.capturedAt, { surplusHeld: take });
      working.set(reservation.id, mutated.next);
      reservationUpdates.push(mutated.update);
      reservationLedger.push(mutated.ledger);
      surplusCases.push(
        buildReservationExcess({
          amountPaise: take,
          accountId: account.id,
          reservationId: reservation.id,
          eventId,
          cycleLabel,
        }),
      );
      surplusOnPaying = paise(surplusOnPaying - take);
    }
  }

  const batch: ProposedBatch = {
    events: [event],
    postings,
    openings: [],
    reservationUpdates,
    reservationLedger,
    surplusCases,
  };
  assertConservation("pay_obligation", batch);

  const ledgerAfter = paise(cycle.ledgerRemainingPaise - input.amountPaise);
  const statementAfter = paise(cycle.statementRemainingPaise - input.amountPaise);
  const stillMismatched = cycle.mismatch || ledgerAfter !== statementAfter;
  const releasedTotal = paise(
    reservationLedger.reduce((sum, entry) => sum + entry.deltaReleasedPaise, 0),
  );
  const preview: ConsequencePreview = {
    effects: [
      { kind: "account", label: account.displayName, deltaPaise: paise(-input.amountPaise) },
      { kind: "card", label, deltaPaise: paise(-input.amountPaise) },
      ...(consumedTotal > 0
        ? [{ kind: "reserved" as const, label: `${label} reservation`, deltaPaise: paise(-consumedTotal) }]
        : []),
    ],
    classifications: {
      spent: paise(0),
      income: paise(0),
      invested: paise(0),
      moved: paise(0),
    },
    warnings: stillMismatched
      ? ["Statement mismatch remains unresolved. No fee, refund, or correction was created."]
      : [],
    narrative: [
      `${account.displayName} ${formatInrDelta(paise(-input.amountPaise))}`,
      `${label} liability ${formatInrDelta(paise(-input.amountPaise))}`,
      consumedTotal > 0 ? `Used ${formatInr(consumedTotal)} from the reservation for this cycle` : null,
      releasedTotal > 0
        ? `${formatInr(releasedTotal)} reserved elsewhere is now available because this cycle was paid from ${account.displayName}`
        : null,
      `Paid ${formatInr(input.amountPaise)} to ${label}`,
      !stillMismatched && ledgerAfter === 0 && statementAfter === 0
        ? "This cycle is paid."
        : stillMismatched
          ? `Ledger remaining ${formatInr(ledgerAfter)}; statement remaining ${formatInr(statementAfter)}. Mismatch is unresolved.`
          : `Remaining on this cycle ${formatInr(ledgerAfter)}.`,
      "This is not personal spending.",
    ].filter((line): line is string => Boolean(line)),
  };

  return { batch, preview };
}
