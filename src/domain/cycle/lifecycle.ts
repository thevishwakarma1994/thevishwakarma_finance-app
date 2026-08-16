import { paise, sumPaise, type Paise } from "../money/paise.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type {
  BillingCycleRecord,
  BillingCycleStatus,
  CycleLifecycle,
  FinancialEvent,
  LedgerBillingCycle,
  Posting,
} from "../ledger/types.js";

function isCycleCardPosting(cycleId: string, posting: Posting): boolean {
  return posting.billingCycleId === cycleId && posting.creditCardId !== null;
}

function paymentEventIds(cycleId: string, events: FinancialEvent[]): Set<string> {
  return new Set(
    events
      .filter((event) => event.billingCycleId === cycleId && event.meaning === "pay_obligation")
      .map((event) => event.id),
  );
}

/** Cycle-linked card postings that are not payment reductions (spends, later refunds/adjustments). */
export function expectedStatementAmount(
  cycleId: string,
  events: FinancialEvent[],
  postings: Posting[],
): Paise {
  const payments = paymentEventIds(cycleId, events);
  return sumPaise(
    postings
      .filter((posting) => isCycleCardPosting(cycleId, posting) && !payments.has(posting.eventId))
      .map((posting) => posting.amountPaise),
  );
}

export function cycleAmountPaid(
  cycleId: string,
  events: FinancialEvent[],
  postings: Posting[],
): Paise {
  const payments = paymentEventIds(cycleId, events);
  const cardPayments = sumPaise(
    postings
      .filter((posting) => isCycleCardPosting(cycleId, posting) && payments.has(posting.eventId))
      .map((posting) => posting.amountPaise),
  );
  return paise(-cardPayments);
}

/** Net cycle-linked card postings: ledger activity minus payment reductions. */
export function ledgerRemaining(
  cycleId: string,
  events: FinancialEvent[],
  postings: Posting[],
): Paise {
  return sumPaise(
    postings.filter((posting) => isCycleCardPosting(cycleId, posting)).map((posting) => posting.amountPaise),
  );
}

export function statementRemaining(
  actualStatementAmountPaise: Paise | null,
  expectedAmountPaise: Paise,
  amountPaidPaise: Paise,
): Paise {
  const billed = actualStatementAmountPaise ?? expectedAmountPaise;
  return paise(billed - amountPaidPaise);
}

export function payablePaise(ledgerRemainingPaise: Paise, statementRemainingPaise: Paise): Paise {
  return paise(Math.min(ledgerRemainingPaise, statementRemainingPaise));
}

export function remainingToIssuer(
  actualStatementAmountPaise: Paise | null,
  expectedAmountPaise: Paise,
  amountPaidPaise: Paise,
): Paise {
  return statementRemaining(actualStatementAmountPaise, expectedAmountPaise, amountPaidPaise);
}

export function deriveCycleStatus(
  cycle: BillingCycleRecord,
  amounts: {
    expectedAmountPaise: Paise;
    amountPaidPaise: Paise;
    ledgerRemainingPaise: Paise;
    statementRemainingPaise: Paise;
    mismatch: boolean;
  },
  asOf: IsoDate,
): BillingCycleStatus {
  const dueOn = cycle.actualDueOn ?? cycle.expectedDueOn;
  const billed =
    amounts.amountPaidPaise > 0 ||
    amounts.expectedAmountPaise > 0 ||
    cycle.actualStatementAmountPaise !== null;
  const settled =
    !amounts.mismatch &&
    amounts.ledgerRemainingPaise <= 0 &&
    amounts.statementRemainingPaise <= 0 &&
    billed;
  if (settled) {
    return "paid";
  }
  if (dueOn <= asOf && (amounts.ledgerRemainingPaise > 0 || amounts.statementRemainingPaise > 0)) {
    return "due";
  }
  if (cycle.actualStatementAmountPaise !== null) {
    return "statement_confirmed";
  }
  if (cycle.expectedStatementOn <= asOf) {
    return "statement_expected";
  }
  return "open";
}

export function deriveCycleLifecycle(
  status: BillingCycleStatus,
  amounts: {
    amountPaidPaise: Paise;
    ledgerRemainingPaise: Paise;
    statementRemainingPaise: Paise;
    mismatch: boolean;
  },
): CycleLifecycle {
  if (status === "paid" || status === "closed") {
    return "paid";
  }
  if (status === "due") {
    return "overdue";
  }
  if (
    amounts.amountPaidPaise > 0 &&
    (amounts.ledgerRemainingPaise > 0 || amounts.statementRemainingPaise > 0 || amounts.mismatch)
  ) {
    return "partially_paid";
  }
  if (status === "statement_confirmed") {
    return "statement_recorded";
  }
  if (status === "statement_expected") {
    return "statement_expected";
  }
  return "accumulating";
}

export function enrichBillingCycle(
  cycle: BillingCycleRecord,
  events: FinancialEvent[],
  postings: Posting[],
  asOf: IsoDate,
): LedgerBillingCycle {
  const expectedAmountPaise = expectedStatementAmount(cycle.id, events, postings);
  const amountPaidPaise = cycleAmountPaid(cycle.id, events, postings);
  const ledgerRemainingPaise = ledgerRemaining(cycle.id, events, postings);
  const statementRemainingPaise = statementRemaining(
    cycle.actualStatementAmountPaise,
    expectedAmountPaise,
    amountPaidPaise,
  );
  const mismatch =
    cycle.actualStatementAmountPaise !== null &&
    cycle.actualStatementAmountPaise !== expectedAmountPaise;
  const remainingPaise = payablePaise(ledgerRemainingPaise, statementRemainingPaise);
  const status = deriveCycleStatus(
    cycle,
    {
      expectedAmountPaise,
      amountPaidPaise,
      ledgerRemainingPaise,
      statementRemainingPaise,
      mismatch,
    },
    asOf,
  );
  return {
    ...cycle,
    expectedAmountPaise,
    amountPaidPaise,
    ledgerRemainingPaise,
    statementRemainingPaise,
    remainingPaise,
    mismatch,
    status,
    lifecycle: deriveCycleLifecycle(status, {
      amountPaidPaise,
      ledgerRemainingPaise,
      statementRemainingPaise,
      mismatch,
    }),
  };
}

export function enrichBillingCycles(
  cycles: BillingCycleRecord[],
  events: FinancialEvent[],
  postings: Posting[],
  asOf: IsoDate,
): LedgerBillingCycle[] {
  return cycles.map((cycle) => enrichBillingCycle(cycle, events, postings, asOf));
}

export function formatCardLabel(displayName: string, mask: string | null): string {
  return mask ? `${displayName} •${mask}` : displayName;
}
