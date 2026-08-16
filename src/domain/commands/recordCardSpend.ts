import { paise, sumPaise } from "../money/paise.js";
import { formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import { assignBillingCycle, type CardCycleRule } from "../cycle/assign.js";
import { formatCardLabel } from "../cycle/lifecycle.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { ExpenseAllocation } from "./recordExpense.js";
import {
  DomainError,
  type BillingCycleRecord,
  type ConsequencePreview,
  type FinancialEvent,
  type LedgerSnapshot,
  type Posting,
  type ProposedBatch,
} from "../ledger/types.js";

export type RecordCardSpendInput = {
  occurredOn: IsoDate;
  capturedAt: string;
  creditCardId: string;
  allocations: ExpenseAllocation[];
  merchant?: string | null;
  notes?: string | null;
  channel?: string | null;
  rule: CardCycleRule;
};

export function recordCardSpend(
  input: RecordCardSpendInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  const card = snapshot.creditCards.find((item) => item.id === input.creditCardId);
  if (!card || card.status !== "active") {
    throw new DomainError("card_not_found", "Credit card not found");
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
  const assigned = assignBillingCycle(input.occurredOn, input.rule);
  const existing = snapshot.billingCycles.find(
    (cycle) =>
      cycle.creditCardId === card.id && cycle.expectedStatementOn === assigned.expectedStatementOn,
  );

  const cycle: BillingCycleRecord = existing
    ? {
        id: existing.id,
        creditCardId: existing.creditCardId,
        purchaseWindowStart: existing.purchaseWindowStart,
        purchaseWindowEnd: existing.purchaseWindowEnd,
        expectedStatementOn: existing.expectedStatementOn,
        actualStatementOn: existing.actualStatementOn,
        expectedDueOn: existing.expectedDueOn,
        actualDueOn: existing.actualDueOn,
        actualStatementAmountPaise: existing.actualStatementAmountPaise,
        ruleSnapshot: existing.ruleSnapshot,
      }
    : {
        id: newId(),
        creditCardId: card.id,
        purchaseWindowStart: assigned.purchaseWindowStart,
        purchaseWindowEnd: assigned.purchaseWindowEnd,
        expectedStatementOn: assigned.expectedStatementOn,
        actualStatementOn: null,
        expectedDueOn: assigned.expectedDueOn,
        actualDueOn: null,
        actualStatementAmountPaise: null,
        ruleSnapshot: assigned.ruleSnapshot,
      };

  const eventId = newId();
  const headerCategoryId =
    input.allocations.length === 1 ? (input.allocations[0]?.categoryId ?? null) : null;
  const label = formatCardLabel(card.displayName, card.mask);

  const event: FinancialEvent = {
    id: eventId,
    meaning: "spend_card",
    occurredOn: input.occurredOn,
    capturedAt: input.capturedAt,
    amountPaise: total,
    accountId: null,
    creditCardId: card.id,
    loanId: null,
    billingCycleId: cycle.id,
    fundingCycleId: null,
    categoryId: headerCategoryId,
    channel: input.channel ?? "card",
    merchant: input.merchant ?? null,
    notes: input.notes ?? null,
    reversalOfEventId: null,
  };

  const postings: Posting[] = [
    {
      id: newId(),
      eventId,
      amountPaise: total,
      accountId: null,
      creditCardId: card.id,
      loanId: null,
      pnl: null,
      categoryId: null,
      claimId: null,
      billingCycleId: cycle.id,
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
      billingCycleId: cycle.id,
    })),
  ];

  const batch: ProposedBatch = {
    events: [event],
    postings,
    openings: [],
    billingCycles: existing ? [] : [cycle],
  };
  assertConservation("spend_card", batch);

  const preview: ConsequencePreview = {
    effects: [
      { kind: "card", label, deltaPaise: total },
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
      `${label} liability ${formatInrDelta(total)}`,
      ...input.allocations.map((allocation) => {
        const name =
          snapshot.categories.find((category) => category.id === allocation.categoryId)?.name ??
          "Expense";
        return `${name} ${formatInrDelta(allocation.amountPaise)}`;
      }),
      "Bank and cash are unchanged.",
      "This counts toward your personal spending.",
    ],
  };

  return { batch, preview };
}
