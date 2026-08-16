import { paise, sumPaise } from "../money/paise.js";
import { formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
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

export type ExpenseAllocation = {
  categoryId: string;
  amountPaise: Paise;
};

export type RecordExpenseInput = {
  occurredOn: IsoDate;
  capturedAt: string;
  accountId: string;
  allocations: ExpenseAllocation[];
  merchant?: string | null;
  notes?: string | null;
  channel?: string | null;
};

export function recordExpense(
  input: RecordExpenseInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  const account = snapshot.accounts.find((item) => item.id === input.accountId);
  if (!account || account.status !== "active") {
    throw new DomainError("account_not_found", "Account not found");
  }
  if (input.allocations.length === 0) {
    throw new DomainError("invalid_expense", "At least one category allocation is required");
  }

  for (const allocation of input.allocations) {
    if (allocation.amountPaise <= 0) {
      throw new DomainError("invalid_amount", "Each allocation must be greater than zero");
    }
    if (!snapshot.categories.some((category) => category.id === allocation.categoryId && !category.archivedAt)) {
      throw new DomainError("category_not_found", "Category not found");
    }
  }

  const total = sumPaise(input.allocations.map((item) => item.amountPaise));
  if (total > account.balancePaise) {
    throw new DomainError(
      "insufficient_balance",
      "This expense exceeds the money currently in the account",
    );
  }

  const eventId = newId();
  const headerCategoryId =
    input.allocations.length === 1 ? (input.allocations[0]?.categoryId ?? null) : null;

  const event: FinancialEvent = {
    id: eventId,
    meaning: "spend_account",
    occurredOn: input.occurredOn,
    capturedAt: input.capturedAt,
    amountPaise: total,
    accountId: account.id,
    creditCardId: null,
    loanId: null,
    billingCycleId: null,
    fundingCycleId: null,
    categoryId: headerCategoryId,
    channel: input.channel ?? null,
    merchant: input.merchant ?? null,
    notes: input.notes ?? null,
    reversalOfEventId: null,
  };

  const postings: Posting[] = [
    {
      id: newId(),
      eventId,
      amountPaise: paise(-total),
      accountId: account.id,
      creditCardId: null,
      loanId: null,
      pnl: null,
      categoryId: null,
      claimId: null,
      billingCycleId: null,
    },
    ...input.allocations.map((allocation) => ({
      id: newId(),
      eventId,
      amountPaise: allocation.amountPaise,
      accountId: null,
      creditCardId: null,
      loanId: null,
      pnl: "expense" as const,
      categoryId: allocation.categoryId,
      claimId: null,
      billingCycleId: null,
    })),
  ];

  const batch: ProposedBatch = { events: [event], postings, openings: [] };
  assertConservation("spend_account", batch);

  const preview: ConsequencePreview = {
    effects: [
      { kind: "account", label: account.displayName, deltaPaise: paise(-total) },
      ...input.allocations.map((allocation) => ({
        kind: "expense" as const,
        label:
          snapshot.categories.find((category) => category.id === allocation.categoryId)?.name ??
          "Expense",
        deltaPaise: allocation.amountPaise,
      })),
    ],
    classifications: {
      spent: total,
      income: paise(0),
      invested: paise(0),
      moved: paise(0),
    },
    warnings: [],
    narrative: [
      `${account.displayName} ${formatInrDelta(paise(-total))}`,
      ...input.allocations.map((allocation) => {
        const name =
          snapshot.categories.find((category) => category.id === allocation.categoryId)?.name ??
          "Expense";
        return `${name} ${formatInrDelta(allocation.amountPaise)}`;
      }),
      "This counts toward your personal spending.",
    ],
  };

  return { batch, preview };
}
