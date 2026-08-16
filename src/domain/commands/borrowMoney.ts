import { paise } from "../money/paise.js";
import { formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { Paise } from "../money/paise.js";
import { buildPayableClaim, claimIncreasePosting, requireActivePerson } from "./shares.js";
import {
  DomainError,
  type ConsequencePreview,
  type FinancialEvent,
  type LedgerSnapshot,
  type Posting,
  type ProposedBatch,
} from "../ledger/types.js";

export type BorrowMoneyInput = {
  occurredOn: IsoDate;
  capturedAt: string;
  accountId: string;
  personId: string;
  amountPaise: Paise;
  notes?: string | null;
};

export function borrowMoney(
  input: BorrowMoneyInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  const account = snapshot.accounts.find((item) => item.id === input.accountId);
  if (!account || account.status !== "active") {
    throw new DomainError("account_not_found", "Account not found");
  }
  const person = requireActivePerson(snapshot, input.personId);
  if (input.amountPaise <= 0) {
    throw new DomainError("invalid_amount", "Amount must be greater than zero");
  }

  const eventId = newId();
  const event: FinancialEvent = {
    id: eventId,
    meaning: "borrow",
    occurredOn: input.occurredOn,
    capturedAt: input.capturedAt,
    amountPaise: input.amountPaise,
    accountId: account.id,
    creditCardId: null,
    loanId: null,
    billingCycleId: null,
    fundingCycleId: null,
    categoryId: null,
    channel: null,
    merchant: null,
    notes: input.notes ?? null,
    reversalOfEventId: null,
  };
  const claim = buildPayableClaim({
    personId: person.id,
    kind: "borrowing",
    amountPaise: input.amountPaise,
    originatingEventId: eventId,
  });
  const postings: Posting[] = [
    {
      id: newId(),
      eventId,
      amountPaise: input.amountPaise,
      accountId: account.id,
      creditCardId: null,
      loanId: null,
      pnl: null,
      categoryId: null,
      claimId: null,
      billingCycleId: null,
    },
    claimIncreasePosting(eventId, claim.id, input.amountPaise),
  ];
  const batch: ProposedBatch = {
    events: [event],
    postings,
    openings: [],
    claims: [claim],
  };
  assertConservation("borrow", batch);

  const preview: ConsequencePreview = {
    effects: [
      { kind: "account", label: account.displayName, deltaPaise: input.amountPaise },
      { kind: "claim", label: `You owe ${person.name}`, deltaPaise: input.amountPaise },
    ],
    classifications: {
      spent: paise(0),
      income: paise(0),
      invested: paise(0),
      moved: paise(0),
    },
    warnings: [],
    narrative: [
      `${account.displayName} ${formatInrDelta(input.amountPaise)}`,
      `Borrowed ${formatInrDelta(input.amountPaise)} from ${person.name}`,
      "This is not income.",
    ],
  };
  return { batch, preview };
}
