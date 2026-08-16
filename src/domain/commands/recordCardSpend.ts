import { paise, sumPaise } from "../money/paise.js";
import { formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import { resolveBillingCycle } from "../cycle/resolve.js";
import { formatCardLabel } from "../cycle/lifecycle.js";
import type { CardCycleRule } from "../cycle/assign.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { ExpenseAllocation } from "./recordExpense.js";
import type { Paise } from "../money/paise.js";
import {
  buildEventShares,
  buildReceivableClaim,
  buildUserOnlyShare,
  claimIncreasePosting,
  requireActivePerson,
} from "./shares.js";
import {
  DomainError,
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
  amountPaise?: Paise;
  ownerPersonId?: string | null;
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

  const ownerPersonId =
    input.ownerPersonId === undefined ? card.defaultOwnerPersonId : input.ownerPersonId;
  const owner =
    ownerPersonId === null ? null : requireActivePerson(snapshot, ownerPersonId);
  const otherOwned = owner !== null;

  if (otherOwned) {
    if (input.allocations.length > 0) {
      throw new DomainError(
        "invalid_expense",
        "Someone else's card purchase does not take a personal category",
      );
    }
    if (input.amountPaise === undefined || input.amountPaise <= 0) {
      throw new DomainError("invalid_amount", "Amount must be greater than zero");
    }
  } else {
    if (input.allocations.length === 0) {
      throw new DomainError("invalid_expense", "At least one category allocation is required");
    }
  }

  for (const allocation of input.allocations) {
    if (allocation.amountPaise <= 0) {
      throw new DomainError("invalid_amount", "Each allocation must be greater than zero");
    }
    if (!snapshot.categories.some((category) => category.id === allocation.categoryId && !category.archivedAt)) {
      throw new DomainError("category_not_found", "Category not found");
    }
  }

  const total = otherOwned
    ? paise(input.amountPaise ?? 0)
    : sumPaise(input.allocations.map((item) => item.amountPaise));
  const { cycle, isNew } = resolveBillingCycle(
    card.id,
    input.occurredOn,
    input.rule,
    snapshot.billingCycles,
  );

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
    obligationInstanceId: null,
    categoryId: headerCategoryId,
    channel: input.channel ?? "card",
    merchant: input.merchant ?? null,
    notes: input.notes ?? null,
    reversalOfEventId: null,
  };

  const claim = otherOwned
    ? buildReceivableClaim({
        personId: owner.id,
        kind: "card_share",
        amountPaise: total,
        originatingEventId: eventId,
        billingCycleId: cycle.id,
      })
    : null;

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
    ...(claim ? [claimIncreasePosting(eventId, claim.id, total, cycle.id)] : []),
  ];

  const eventShares = otherOwned
    ? buildEventShares(eventId, paise(0), [{ personId: owner.id, amountPaise: total }])
    : buildUserOnlyShare(eventId, total);

  const batch: ProposedBatch = {
    events: [event],
    postings,
    openings: [],
    billingCycles: isNew ? [cycle] : [],
    claims: claim ? [claim] : [],
    eventShares,
  };
  assertConservation("spend_card", batch);

  const usedDefaultOwner = Boolean(owner && owner.id === card.defaultOwnerPersonId);
  const ownerName = owner?.name ?? "Someone";
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
      ...(claim
        ? [{ kind: "claim" as const, label: `${ownerName} owes you`, deltaPaise: total }]
        : []),
    ],
    classifications: {
      spent: otherOwned ? paise(0) : total,
      income: paise(0),
      invested: paise(0),
      moved: paise(0),
    },
    warnings: usedDefaultOwner ? [`This purchase is ${ownerName}'s by default`] : [],
    narrative: otherOwned
      ? [
          `${label} liability ${formatInrDelta(total)}`,
          usedDefaultOwner
            ? `This purchase is ${ownerName}'s by default`
            : `This purchase is ${ownerName}'s`,
          `${ownerName} owes you ${formatInrDelta(total)}`,
          "This is not your personal spending.",
        ]
      : [
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
