import { paise } from "../money/paise.js";
import { formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import { accountAvailability } from "../engine/liquidity.js";
import { remainingObligationPaise } from "../obligations/generate.js";
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

export type RecordObligationPaymentInput = {
  occurredOn: IsoDate;
  capturedAt: string;
  instanceId: string;
  accountId: string;
  amountPaise: Paise;
  notes?: string | null;
  channel?: string | null;
};

export function recordObligationPayment(
  input: RecordObligationPaymentInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  if (input.amountPaise <= 0) {
    throw new DomainError("invalid_amount", "Payment amount must be greater than zero");
  }

  const instance = snapshot.obligationInstances.find((item) => item.id === input.instanceId);
  if (!instance) {
    throw new DomainError("obligation_not_found", "Obligation not found");
  }
  if (instance.status !== "open") {
    throw new DomainError("obligation_not_open", "This obligation is not open");
  }

  const remaining = remainingObligationPaise(instance);
  if (input.amountPaise !== remaining) {
    throw new DomainError(
      "full_payment_required",
      "This version supports paying the full remaining amount only",
    );
  }

  const account = snapshot.accounts.find((item) => item.id === input.accountId);
  if (!account || account.status !== "active") {
    throw new DomainError("account_not_found", "Payment account not found");
  }

  const available = accountAvailability(snapshot, account.id);
  if (input.amountPaise > available.availablePaise) {
    throw new DomainError(
      "insufficient_available",
      "This payment exceeds available money in the account",
    );
  }

  const eventId = newId();
  const event: FinancialEvent = {
    id: eventId,
    meaning: "pay_obligation",
    occurredOn: input.occurredOn,
    capturedAt: input.capturedAt,
    amountPaise: input.amountPaise,
    accountId: account.id,
    creditCardId: null,
    loanId: null,
    billingCycleId: null,
    fundingCycleId: instance.fundingCycleId,
    obligationInstanceId: instance.id,
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
      billingCycleId: null,
    },
  ];

  const batch: ProposedBatch = {
    events: [event],
    postings,
    openings: [],
    obligationInstanceUpdates: [
      {
        id: instance.id,
        status: "paid",
        paidEventId: eventId,
      },
    ],
  };
  assertConservation("pay_obligation", batch);

  const preview: ConsequencePreview = {
    effects: [{ kind: "account", label: account.displayName, deltaPaise: paise(-input.amountPaise) }],
    classifications: {
      spent: paise(0),
      income: paise(0),
      invested: paise(0),
      moved: input.amountPaise,
    },
    warnings: [],
    narrative: [
      `${account.displayName} ${formatInrDelta(paise(-input.amountPaise))}`,
      `Paid ${instance.nameSnapshot}`,
    ],
  };

  return { batch, preview };
}

export function skipObligationInstance(
  instanceId: string,
  snapshot: LedgerSnapshot,
): { id: string; status: "skipped"; paidEventId: null } {
  const instance = snapshot.obligationInstances.find((item) => item.id === instanceId);
  if (!instance) {
    throw new DomainError("obligation_not_found", "Obligation not found");
  }
  if (instance.status !== "open") {
    throw new DomainError("obligation_not_open", "This obligation is not open");
  }
  return { id: instance.id, status: "skipped", paidEventId: null };
}
