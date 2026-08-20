import { paise } from "../money/paise.js";
import { formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import { isoDate, type IsoDate } from "../calendar/isoDate.js";
import type { Paise } from "../money/paise.js";
import {
  DomainError,
  type ConsequencePreview,
  type FinancialEvent,
  type LedgerSnapshot,
  type Posting,
  type ProposedBatch,
} from "../ledger/types.js";
import { policyAsOf } from "../funding/cycles.js";

export type RecordIncomeInput = {
  commandId?: string;
  occurredOn: IsoDate;
  capturedAt: string;
  amountPaise: Paise;
  accountId: string;
  kind: "salary" | "other";
  notes?: string | null;
  fundingCycleId?: string | null;
};

export function recordIncome(
  input: RecordIncomeInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  const account = snapshot.accounts.find((item) => item.id === input.accountId);
  if (!account || account.status !== "active") {
    throw new DomainError("account_not_found", "Account not found");
  }
  if (input.amountPaise <= 0) {
    throw new DomainError("invalid_amount", "Income must be greater than zero");
  }

  const eventId = input.commandId ?? newId();
  const pnl = input.kind === "salary" ? "income_salary" : "income_other";
  let fundingCycleId: string | null = null;
  let fundingCycleUpdates: ProposedBatch["fundingCycleUpdates"];

  if (input.kind === "salary" && input.fundingCycleId) {
    const existing = snapshot.fundingCycles.find((cycle) => cycle.id === input.fundingCycleId);
    if (!existing) {
      throw new DomainError("cycle_not_found", "Salary period not found");
    }
    if (existing.salaryEventId) {
      throw new DomainError("already_received", "This salary period already has a salary event");
    }
    const monthStart = isoDate(
      `${String(existing.year).padStart(4, "0")}-${String(existing.month).padStart(2, "0")}-01`,
    );
    const policy = policyAsOf(snapshot.incomePolicies, monthStart);
    if (!policy) {
      throw new DomainError("invalid_salary_schedule", "That salary period is not covered by the current schedule");
    }
    fundingCycleId = existing.id;
    fundingCycleUpdates = [
      {
        id: existing.id,
        actualArrivalOn: input.occurredOn,
        actualAmountPaise: input.amountPaise,
        salaryEventId: eventId,
      },
    ];
  }

  const event: FinancialEvent = {
    id: eventId,
    meaning: "income",
    occurredOn: input.occurredOn,
    capturedAt: input.capturedAt,
    amountPaise: input.amountPaise,
    accountId: account.id,
    creditCardId: null,
    loanId: null,
    billingCycleId: null,
    fundingCycleId,
    obligationInstanceId: null,
    categoryId: null,
    channel: null,
    merchant: null,
    notes: input.notes ?? null,
    reversalOfEventId: null,
  };

  const postings: Posting[] = [
    {
      id: `${eventId}_p1`,
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
    {
      id: `${eventId}_p2`,
      eventId,
      amountPaise: input.amountPaise,
      accountId: null,
      creditCardId: null,
      loanId: null,
      pnl,
      categoryId: null,
      claimId: null,
      billingCycleId: null,
    },
  ];

  const batch: ProposedBatch = {
    events: [event],
    postings,
    openings: [],
    fundingCycleUpdates,
  };
  assertConservation("income", batch);

  const incomeLabel = input.kind === "salary" ? "Salary income" : "Other income";
  const preview: ConsequencePreview = {
    effects: [
      { kind: "account", label: account.displayName, deltaPaise: input.amountPaise },
      { kind: "income", label: incomeLabel, deltaPaise: input.amountPaise },
    ],
    classifications: {
      spent: paise(0),
      income: input.amountPaise,
      invested: paise(0),
      moved: paise(0),
    },
    warnings: [],
    narrative: [
      `${account.displayName} ${formatInrDelta(input.amountPaise)}`,
      `${incomeLabel} ${formatInrDelta(input.amountPaise)}`,
    ],
  };

  return { batch, preview };
}
