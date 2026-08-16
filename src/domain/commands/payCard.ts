import { paise } from "../money/paise.js";
import { formatInr, formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import { formatCardLabel, payablePaise } from "../cycle/lifecycle.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { Paise } from "../money/paise.js";
import {
  DomainError,
  type ConsequencePreview,
  type FinancialEvent,
  type LedgerSnapshot,
  type Posting,
  type ProposedBatch,
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

  if (input.amountPaise > account.balancePaise) {
    throw new DomainError(
      "insufficient_balance",
      "This payment exceeds the money currently in the account",
    );
  }

  const eventId = newId();
  const label = formatCardLabel(card.displayName, card.mask);

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

  const batch: ProposedBatch = { events: [event], postings, openings: [] };
  assertConservation("pay_obligation", batch);

  const ledgerAfter = paise(cycle.ledgerRemainingPaise - input.amountPaise);
  const statementAfter = paise(cycle.statementRemainingPaise - input.amountPaise);
  const stillMismatched = cycle.mismatch || ledgerAfter !== statementAfter;
  const preview: ConsequencePreview = {
    effects: [
      { kind: "account", label: account.displayName, deltaPaise: paise(-input.amountPaise) },
      { kind: "card", label, deltaPaise: paise(-input.amountPaise) },
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
      `Paid ${formatInr(input.amountPaise)} to ${label}`,
      !stillMismatched && ledgerAfter === 0 && statementAfter === 0
        ? "This cycle is paid."
        : stillMismatched
          ? `Ledger remaining ${formatInr(ledgerAfter)}; statement remaining ${formatInr(statementAfter)}. Mismatch is unresolved.`
          : `Remaining on this cycle ${formatInr(ledgerAfter)}.`,
      "This is not personal spending.",
    ],
  };

  return { batch, preview };
}
