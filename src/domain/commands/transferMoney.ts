import { paise } from "../money/paise.js";
import { formatInr, formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { Paise } from "../money/paise.js";
import { requireAvailable } from "../engine/liquidity.js";
import {
  DomainError,
  type ConsequencePreview,
  type FinancialEvent,
  type LedgerSnapshot,
  type Posting,
  type ProposedBatch,
} from "../ledger/types.js";

export type TransferMoneyInput = {
  occurredOn: IsoDate;
  capturedAt: string;
  amountPaise: Paise;
  fromAccountId: string;
  toAccountId: string;
  notes?: string | null;
  channel?: string | null;
};

export function transferMoney(
  input: TransferMoneyInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  if (input.fromAccountId === input.toAccountId) {
    throw new DomainError("same_account", "Choose two different accounts");
  }
  if (input.amountPaise <= 0) {
    throw new DomainError("invalid_amount", "Transfer amount must be greater than zero");
  }

  const source = snapshot.accounts.find((item) => item.id === input.fromAccountId);
  const destination = snapshot.accounts.find((item) => item.id === input.toAccountId);
  if (!source || source.status !== "active") {
    throw new DomainError("account_not_found", "Source account not found");
  }
  if (!destination || destination.status !== "active") {
    throw new DomainError("account_not_found", "Destination account not found");
  }
  if (input.amountPaise > source.balancePaise) {
    throw new DomainError(
      "insufficient_balance",
      "This transfer exceeds the money currently in the source account",
    );
  }
  requireAvailable(snapshot, source.id, input.amountPaise, "This transfer");

  const eventId = newId();
  // Transfer convention: event.accountId is the source account.
  // Destination is the positive account posting, not a second event field.
  const event: FinancialEvent = {
    id: eventId,
    meaning: "transfer",
    occurredOn: input.occurredOn,
    capturedAt: input.capturedAt,
    amountPaise: input.amountPaise,
    accountId: source.id,
    creditCardId: null,
    loanId: null,
    billingCycleId: null,
    fundingCycleId: null,
    obligationInstanceId: null,
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
      accountId: source.id,
      creditCardId: null,
      loanId: null,
      pnl: null,
      categoryId: null,
      claimId: null,
      billingCycleId: null,
    },
    {
      id: newId(),
      eventId,
      amountPaise: input.amountPaise,
      accountId: destination.id,
      creditCardId: null,
      loanId: null,
      pnl: null,
      categoryId: null,
      claimId: null,
      billingCycleId: null,
    },
  ];

  const batch: ProposedBatch = { events: [event], postings, openings: [] };
  assertConservation("transfer", batch);

  const preview: ConsequencePreview = {
    effects: [
      { kind: "account", label: source.displayName, deltaPaise: paise(-input.amountPaise) },
      { kind: "account", label: destination.displayName, deltaPaise: input.amountPaise },
    ],
    classifications: {
      spent: paise(0),
      income: paise(0),
      invested: paise(0),
      moved: input.amountPaise,
    },
    warnings: [],
    narrative: [
      `${source.displayName} ${formatInrDelta(paise(-input.amountPaise))}`,
      `${destination.displayName} ${formatInrDelta(input.amountPaise)}`,
      `Moved ${formatInr(input.amountPaise)} from ${source.displayName} to ${destination.displayName}`,
    ],
  };

  return { batch, preview };
}
