import { paise } from "../money/paise.js";
import { formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { Paise } from "../money/paise.js";
import { isoDateParts } from "../calendar/isoDate.js";
import {
  DomainError,
  type ConsequencePreview,
  type FinancialEvent,
  type FundingCycleRecord,
  type LedgerSnapshot,
  type Posting,
  type ProposedBatch,
} from "../ledger/types.js";
import { buildFundingCycle, policyAsOf } from "../funding/cycles.js";

export type RecordIncomeInput = {
  occurredOn: IsoDate;
  capturedAt: string;
  amountPaise: Paise;
  accountId: string;
  kind: "salary" | "other";
  notes?: string | null;
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

  const eventId = newId();
  const pnl = input.kind === "salary" ? "income_salary" : "income_other";
  let fundingCycleId: string | null = null;
  let fundingCycles: FundingCycleRecord[] | undefined;
  let fundingCycleUpdates: ProposedBatch["fundingCycleUpdates"];

  if (input.kind === "salary") {
    const parts = isoDateParts(input.occurredOn);
    const existing = snapshot.fundingCycles.find(
      (cycle) => cycle.year === parts.year && cycle.month === parts.month,
    );
    if (existing?.salaryEventId) {
      throw new DomainError("duplicate_salary", "This salary period already has a salary event");
    }
    const policy = policyAsOf(snapshot.incomePolicies, input.occurredOn);
    if (existing) {
      fundingCycleId = existing.id;
      fundingCycleUpdates = [
        {
          id: existing.id,
          actualArrivalOn: input.occurredOn,
          actualAmountPaise: input.amountPaise,
          salaryEventId: eventId,
        },
      ];
    } else if (policy) {
      const cycle = buildFundingCycle(policy, parts.year, parts.month);
      fundingCycleId = cycle.id;
      fundingCycles = [
        {
          ...cycle,
          actualArrivalOn: input.occurredOn,
          actualAmountPaise: input.amountPaise,
          salaryEventId: eventId,
        },
      ];
    }
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
    categoryId: null,
    channel: null,
    merchant: null,
    notes: input.notes ?? null,
    reversalOfEventId: null,
  };

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
    {
      id: newId(),
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
    fundingCycles,
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
