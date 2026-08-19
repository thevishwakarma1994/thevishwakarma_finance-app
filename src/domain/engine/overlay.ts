import { paise } from "../money/paise.js";
import { enrichBillingCycles } from "../cycle/lifecycle.js";
import { enrichClaim } from "../claims/derive.js";
import { enrichReservation } from "../reservations/derive.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { LedgerSnapshot, ProposedBatch, LedgerClaim } from "../ledger/types.js";
import type { Paise } from "../money/paise.js";

export function cloneSnapshot(snapshot: LedgerSnapshot): LedgerSnapshot {
  return {
    accounts: snapshot.accounts.map((item) => ({ ...item })),
    categories: snapshot.categories.map((item) => ({ ...item })),
    creditCards: snapshot.creditCards.map((item) => ({ ...item })),
    people: snapshot.people.map((item) => ({ ...item })),
    billingCycles: snapshot.billingCycles.map((item) => ({ ...item })),
    claims: snapshot.claims.map((item) => ({ ...item })),
    eventShares: snapshot.eventShares.map((item) => ({ ...item })),
    settlementAllocations: snapshot.settlementAllocations.map((item) => ({ ...item })),
    reservations: snapshot.reservations.map((item) => ({ ...item })),
    reservationLedger: snapshot.reservationLedger.map((item) => ({ ...item })),
    surplusCases: snapshot.surplusCases.map((item) => ({ ...item })),
    events: snapshot.events.map((item) => ({ ...item })),
    postings: snapshot.postings.map((item) => ({ ...item })),
    openings: snapshot.openings.map((item) => ({ ...item })),
    incomePolicies: snapshot.incomePolicies.map((item) => ({ ...item })),
    fundingCycles: snapshot.fundingCycles.map((item) => ({ ...item })),
    cardRules: snapshot.cardRules.map((item) => ({ ...item, rule: { ...item.rule } })),
    extraObligations: snapshot.extraObligations.map((item) => ({ ...item })),
    obligationTemplates: snapshot.obligationTemplates.map((item) => ({ ...item, dueRule: { ...item.dueRule } })),
    obligationInstances: snapshot.obligationInstances.map((item) => ({ ...item })),
    budgets: snapshot.budgets.map((item) => ({ ...item })),
  };
}

export function applyBatchOverlay(
  snapshot: LedgerSnapshot,
  batch: ProposedBatch,
  asOf: IsoDate,
): LedgerSnapshot {
  const next = cloneSnapshot(snapshot);
  next.events = [...next.events, ...batch.events];
  next.postings = [...next.postings, ...batch.postings];
  next.openings = [...next.openings, ...batch.openings];
  if (batch.eventShares) next.eventShares = [...next.eventShares, ...batch.eventShares];
  if (batch.settlementAllocations) {
    next.settlementAllocations = [...next.settlementAllocations, ...batch.settlementAllocations];
  }
  const eventMeanings = new Map<string, string>();
  next.events.forEach((e) => eventMeanings.set(e.id, e.meaning));
  
  const correctionPostingsByClaim = new Map<string, number>();
  next.postings.forEach((p) => {
    if (p.claimId && eventMeanings.get(p.eventId) === "correct_opening_claim") {
      // In an overlay scenario, all events in the batch are considered valid for the current asOf,
      // and earlier events are already part of the snapshot (which is already asOf).
      correctionPostingsByClaim.set(
        p.claimId,
        (correctionPostingsByClaim.get(p.claimId) || 0) + p.amountPaise,
      );
    }
  });

  const enrichWithCorrections = (claim: Omit<LedgerClaim, "openAmountPaise"> & { openAmountPaise?: Paise }) => {
    const isOpening = eventMeanings.get(claim.originatingEventId ?? "") === "apply_opening_claim";
    const correctionDeltas = isOpening ? (correctionPostingsByClaim.get(claim.id) || 0) : 0;
    return enrichClaim(claim, next.settlementAllocations, correctionDeltas);
  };

  if (batch.claims) {
    next.claims = [
      ...next.claims.map(enrichWithCorrections),
      ...batch.claims.map(enrichWithCorrections),
    ];
  } else {
    next.claims = next.claims.map(enrichWithCorrections);
  }
  if (batch.reservations) {
    next.reservations = [
      ...next.reservations,
      ...batch.reservations.map((reservation) => enrichReservation(reservation)),
    ];
  }
  for (const patch of batch.reservationUpdates ?? []) {
    next.reservations = next.reservations.map((reservation) =>
      reservation.id === patch.id
        ? enrichReservation({
            ...reservation,
            amountConsumedPaise: patch.amountConsumedPaise,
            amountReleasedPaise: patch.amountReleasedPaise,
            amountReassignedPaise: patch.amountReassignedPaise,
            amountSurplusHeldPaise: patch.amountSurplusHeldPaise,
            status: patch.status,
          })
        : reservation,
    );
  }
  if (batch.reservationLedger) {
    next.reservationLedger = [...next.reservationLedger, ...batch.reservationLedger];
  }
  if (batch.surplusCases) next.surplusCases = [...next.surplusCases, ...batch.surplusCases];
  if (batch.fundingCycles) next.fundingCycles = [...next.fundingCycles, ...batch.fundingCycles];
  for (const patch of batch.fundingCycleUpdates ?? []) {
    next.fundingCycles = next.fundingCycles.map((cycle) =>
      cycle.id === patch.id
        ? {
            ...cycle,
            actualArrivalOn: patch.actualArrivalOn,
            actualAmountPaise: patch.actualAmountPaise,
            salaryEventId: patch.salaryEventId,
          }
        : cycle,
    );
  }

  if (batch.obligationInstances) {
    next.obligationInstances = [...next.obligationInstances, ...batch.obligationInstances];
  }
  for (const patch of batch.obligationInstanceUpdates ?? []) {
    next.obligationInstances = next.obligationInstances.map((instance) =>
      instance.id === patch.id
        ? { ...instance, status: patch.status, paidEventId: patch.paidEventId }
        : instance,
    );
  }

  const cycleRecords = [
    ...next.billingCycles.map((cycle) => ({
      id: cycle.id,
      creditCardId: cycle.creditCardId,
      purchaseWindowStart: cycle.purchaseWindowStart,
      purchaseWindowEnd: cycle.purchaseWindowEnd,
      expectedStatementOn: cycle.expectedStatementOn,
      actualStatementOn: cycle.actualStatementOn,
      expectedDueOn: cycle.expectedDueOn,
      actualDueOn: cycle.actualDueOn,
      actualStatementAmountPaise: cycle.actualStatementAmountPaise,
      ruleSnapshot: cycle.ruleSnapshot,
    })),
    ...(batch.billingCycles ?? []).filter(
      (cycle) => !next.billingCycles.some((existing) => existing.id === cycle.id),
    ),
  ];
  next.billingCycles = enrichBillingCycles(cycleRecords, next.events, next.postings, asOf);

  next.accounts = next.accounts.map((account) => {
    const delta = (batch.postings ?? [])
      .filter((posting) => posting.accountId === account.id)
      .reduce((sum, posting) => sum + posting.amountPaise, 0);
    return {
      ...account,
      postedPaise: paise(account.postedPaise + delta),
      balancePaise: paise(account.balancePaise + delta),
    };
  });
  return next;
}
