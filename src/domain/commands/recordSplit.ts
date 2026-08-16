import { paise, sumPaise } from "../money/paise.js";
import { formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import { resolveBillingCycle } from "../cycle/resolve.js";
import { formatCardLabel } from "../cycle/lifecycle.js";
import type { CardCycleRule } from "../cycle/assign.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { Paise } from "../money/paise.js";
import type { ExpenseAllocation } from "./recordExpense.js";
import {
  assertSharesMatchTotal,
  buildEventShares,
  buildReceivableClaim,
  claimIncreasePosting,
  requireActivePerson,
  type PersonShareInput,
} from "./shares.js";
import {
  DomainError,
  type ConsequencePreview,
  type FinancialEvent,
  type LedgerSnapshot,
  type Posting,
  type ProposedBatch,
} from "../ledger/types.js";

export type SplitSource =
  | { type: "account"; accountId: string }
  | { type: "card"; creditCardId: string; rule: CardCycleRule };

export type RecordSplitInput = {
  occurredOn: IsoDate;
  capturedAt: string;
  amountPaise: Paise;
  source: SplitSource;
  userSharePaise: Paise;
  personShares: PersonShareInput[];
  allocations: ExpenseAllocation[];
  merchant?: string | null;
  notes?: string | null;
  channel?: string | null;
};

export function recordSplit(
  input: RecordSplitInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  if (input.amountPaise <= 0) {
    throw new DomainError("invalid_amount", "Amount must be greater than zero");
  }
  assertSharesMatchTotal(input.amountPaise, input.userSharePaise, input.personShares);

  for (const share of input.personShares) {
    requireActivePerson(snapshot, share.personId);
  }

  if (input.userSharePaise === paise(0) && input.allocations.length > 0) {
    throw new DomainError("invalid_expense", "A zero user share cannot have expense categories");
  }
  if (input.userSharePaise > 0 && input.allocations.length === 0) {
    throw new DomainError("invalid_expense", "Your share needs at least one category");
  }
  for (const allocation of input.allocations) {
    if (allocation.amountPaise <= 0) {
      throw new DomainError("invalid_amount", "Each allocation must be greater than zero");
    }
    if (!snapshot.categories.some((category) => category.id === allocation.categoryId && !category.archivedAt)) {
      throw new DomainError("category_not_found", "Category not found");
    }
  }
  const allocationTotal = sumPaise(input.allocations.map((item) => item.amountPaise));
  if (allocationTotal !== input.userSharePaise) {
    throw new DomainError("invalid_expense", "Expense categories must sum to your share");
  }

  const eventId = newId();
  const headerCategoryId =
    input.allocations.length === 1 ? (input.allocations[0]?.categoryId ?? null) : null;
  const source = input.source;

  if (source.type === "account") {
    const account = snapshot.accounts.find((item) => item.id === source.accountId);
    if (!account || account.status !== "active") {
      throw new DomainError("account_not_found", "Account not found");
    }
    if (input.amountPaise > account.balancePaise) {
      throw new DomainError(
        "insufficient_balance",
        "This split exceeds the money currently in the account",
      );
    }

    const event: FinancialEvent = {
      id: eventId,
      meaning: "split",
      occurredOn: input.occurredOn,
      capturedAt: input.capturedAt,
      amountPaise: input.amountPaise,
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

    const claims = input.personShares.map((share) =>
      buildReceivableClaim({
        personId: share.personId,
        kind: "shared_bill",
        amountPaise: share.amountPaise,
        originatingEventId: eventId,
      }),
    );

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
      ...claims.map((claim) => claimIncreasePosting(eventId, claim.id, claim.originalAmountPaise)),
    ];

    const eventShares = buildEventShares(eventId, input.userSharePaise, input.personShares);
    const batch: ProposedBatch = {
      events: [event],
      postings,
      openings: [],
      claims,
      eventShares,
    };
    assertConservation("split", batch);

    const preview = splitPreview({
      snapshot,
      sourceLabel: account.displayName,
      sourceDelta: paise(-input.amountPaise),
      sourceKind: "account",
      userSharePaise: input.userSharePaise,
      personShares: input.personShares,
      allocations: input.allocations,
    });
    return { batch, preview };
  }

  const card = snapshot.creditCards.find((item) => item.id === source.creditCardId);
  if (!card || card.status !== "active") {
    throw new DomainError("card_not_found", "Credit card not found");
  }
  const { cycle, isNew } = resolveBillingCycle(
    card.id,
    input.occurredOn,
    source.rule,
    snapshot.billingCycles,
  );
  const label = formatCardLabel(card.displayName, card.mask);

  const event: FinancialEvent = {
    id: eventId,
    meaning: "split",
    occurredOn: input.occurredOn,
    capturedAt: input.capturedAt,
    amountPaise: input.amountPaise,
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

  const claims = input.personShares.map((share) =>
    buildReceivableClaim({
      personId: share.personId,
      kind: "card_share",
      amountPaise: share.amountPaise,
      originatingEventId: eventId,
      billingCycleId: cycle.id,
    }),
  );

  const postings: Posting[] = [
    {
      id: newId(),
      eventId,
      amountPaise: input.amountPaise,
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
    ...claims.map((claim) =>
      claimIncreasePosting(eventId, claim.id, claim.originalAmountPaise, cycle.id),
    ),
  ];

  const eventShares = buildEventShares(eventId, input.userSharePaise, input.personShares);
  const batch: ProposedBatch = {
    events: [event],
    postings,
    openings: [],
    billingCycles: isNew ? [cycle] : [],
    claims,
    eventShares,
  };
  assertConservation("split", batch);

  const preview = splitPreview({
    snapshot,
    sourceLabel: label,
    sourceDelta: input.amountPaise,
    sourceKind: "card",
    userSharePaise: input.userSharePaise,
    personShares: input.personShares,
    allocations: input.allocations,
  });
  return { batch, preview };
}

function splitPreview(input: {
  snapshot: LedgerSnapshot;
  sourceLabel: string;
  sourceDelta: Paise;
  sourceKind: "account" | "card";
  userSharePaise: Paise;
  personShares: PersonShareInput[];
  allocations: ExpenseAllocation[];
}): ConsequencePreview {
  const personLines = input.personShares.map((share) => {
    const name =
      input.snapshot.people.find((person) => person.id === share.personId)?.name ?? "Someone";
    return {
      name,
      amountPaise: share.amountPaise,
    };
  });
  return {
    effects: [
      {
        kind: input.sourceKind === "card" ? "card" : "account",
        label: input.sourceLabel,
        deltaPaise: input.sourceDelta,
      },
      ...input.allocations.map((allocation) => ({
        kind: "expense" as const,
        label:
          input.snapshot.categories.find((category) => category.id === allocation.categoryId)?.name ??
          "Expense",
        deltaPaise: allocation.amountPaise,
      })),
      ...personLines.map((line) => ({
        kind: "claim" as const,
        label: `${line.name} owes you`,
        deltaPaise: line.amountPaise,
      })),
    ],
    classifications: {
      spent: input.userSharePaise,
      income: paise(0),
      invested: paise(0),
      moved: paise(0),
    },
    warnings: [],
    narrative: [
      input.sourceKind === "card"
        ? `${input.sourceLabel} liability ${formatInrDelta(input.sourceDelta)}`
        : `${input.sourceLabel} ${formatInrDelta(input.sourceDelta)}`,
      `You ${formatInrDelta(input.userSharePaise)}`,
      ...personLines.map((line) => `${line.name} ${formatInrDelta(line.amountPaise)}`),
      input.userSharePaise > 0
        ? "Only your share counts toward personal spending."
        : "This is not your personal spending.",
    ],
  };
}
