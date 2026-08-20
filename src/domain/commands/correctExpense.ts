import { paise, sumPaise, type Paise } from "../money/paise.js";
import { formatInrDelta } from "../money/inr.js";
import { isoDate } from "../calendar/isoDate.js";
import { assertConservation } from "../conservation/validate.js";
import { DomainError, type FinancialEvent, type LedgerSnapshot, type Posting } from "../ledger/types.js";
import {
  assertEligibleExpenseCorrection,
  assertCorrectionAvailability,
} from "../corrections/eligibility.js";
import { correctionRootId } from "../corrections/chain.js";
import { buildTransactionReversal, assertExactReversal } from "../corrections/reversal.js";
import { snapshotAfterReversal } from "../corrections/overlay.js";
import {
  canonicalizeExpenseCorrectionPayload,
  type CanonicalExpenseCorrectionPayload,
} from "../corrections/payload.js";
import { recordExpense } from "./recordExpense.js";

export type ExpenseCorrectionSideView = {
  amountPaise: number;
  accountId: string | null;
  accountName: string | null;
  merchant: string | null;
  notes: string | null;
  occurredOn: string;
  categories: { id: string | null; name: string; amountPaise: number }[];
};

export type ExpenseCorrectionPreview = {
  original: ExpenseCorrectionSideView;
  corrected: ExpenseCorrectionSideView;
  impact: { kind: string; label: string; deltaPaise: number }[];
  effects: { kind: string; label: string; deltaPaise: number }[];
  classifications: { spent: number; income: number; invested: number; moved: number };
  warnings: string[];
  narrative: string[];
};

export type CorrectExpenseInput = {
  commandId: string;
  rootEventId: string;
  targetEventId: string;
  amountPaise: number;
  sourceAccountId: string;
  occurredOn: string;
  allocations: { categoryId: string; amountPaise: number }[];
  merchant?: string | null;
  notes?: string | null;
  reason?: string | null;
  capturedAt: string;
  artifactIds?: { reversalEventId: string; replacementEventId: string };
};

export type PreparedExpenseCorrection = {
  rootEventId: string;
  targetEventId: string;
  targetEvent: FinancialEvent;
  targetPostings: Posting[];
  reversalEvent: FinancialEvent;
  reversalPostings: Posting[];
  replacementEvent: FinancialEvent;
  replacementPostings: Posting[];
  material: CanonicalExpenseCorrectionPayload;
  preview: ExpenseCorrectionPreview;
};

function postingsFor(eventId: string, postings: readonly Posting[]): Posting[] {
  return postings.filter((posting) => posting.eventId === eventId);
}

function assignEventId(
  event: FinancialEvent,
  postings: readonly Posting[],
  eventId: string,
): { event: FinancialEvent; postings: Posting[] } {
  return {
    event: { ...event, id: eventId },
    postings: postings.map((posting) => ({ ...posting, eventId })),
  };
}

function remapReplacementAvailability(error: unknown, snapshot: LedgerSnapshot, accountId: string, amount: Paise): never {
  if (error instanceof DomainError && (error.code === "insufficient_available" || error.code === "insufficient_balance")) {
    assertCorrectionAvailability(snapshot, accountId, amount, "This correction");
  }
  throw error;
}

export function expenseSideView(event: FinancialEvent, snapshot: LedgerSnapshot): ExpenseCorrectionSideView {
  const eventPostings = postingsFor(event.id, snapshot.postings);
  const expensePostings = eventPostings.filter((posting) => posting.pnl === "expense");
  const account =
    event.accountId ? snapshot.accounts.find((item) => item.id === event.accountId) : undefined;
  return {
    amountPaise: event.amountPaise,
    accountId: event.accountId,
    accountName: account?.displayName ?? null,
    merchant: event.merchant,
    notes: event.notes,
    occurredOn: event.occurredOn,
    categories: expensePostings.map((posting) => ({
      id: posting.categoryId,
      name: posting.categoryId
        ? (snapshot.categories.find((category) => category.id === posting.categoryId)?.name ?? "Expense")
        : "Expense",
      amountPaise: posting.amountPaise,
    })),
  };
}

export function expenseCorrectionImpact(
  originalPostings: readonly Posting[],
  replacementPostings: readonly Posting[],
  snapshot: LedgerSnapshot,
): { kind: string; label: string; deltaPaise: number }[] {
  const accountDeltas = new Map<string, number>();
  const categoryDeltas = new Map<string, number>();
  for (const posting of originalPostings) {
    if (posting.accountId) {
      accountDeltas.set(posting.accountId, (accountDeltas.get(posting.accountId) ?? 0) - posting.amountPaise);
    }
    if (posting.pnl === "expense" && posting.categoryId) {
      categoryDeltas.set(posting.categoryId, (categoryDeltas.get(posting.categoryId) ?? 0) - posting.amountPaise);
    }
  }
  for (const posting of replacementPostings) {
    if (posting.accountId) {
      accountDeltas.set(posting.accountId, (accountDeltas.get(posting.accountId) ?? 0) + posting.amountPaise);
    }
    if (posting.pnl === "expense" && posting.categoryId) {
      categoryDeltas.set(posting.categoryId, (categoryDeltas.get(posting.categoryId) ?? 0) + posting.amountPaise);
    }
  }

  const impact: { kind: string; label: string; deltaPaise: number }[] = [];
  for (const [accountId, deltaPaise] of [...accountDeltas.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (deltaPaise === 0) continue;
    impact.push({
      kind: "account",
      label: snapshot.accounts.find((account) => account.id === accountId)?.displayName ?? "Account",
      deltaPaise,
    });
  }
  for (const [categoryId, deltaPaise] of [...categoryDeltas.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (deltaPaise === 0) continue;
    impact.push({
      kind: "expense",
      label: snapshot.categories.find((category) => category.id === categoryId)?.name ?? "Expense",
      deltaPaise,
    });
  }
  return impact;
}

export function buildExpenseCorrectionPreview(
  original: FinancialEvent,
  originalPostings: readonly Posting[],
  replacement: FinancialEvent,
  replacementPostings: readonly Posting[],
  snapshot: LedgerSnapshot,
): ExpenseCorrectionPreview {
  const originalView = expenseSideView(original, {
    ...snapshot,
    postings: snapshot.postings.some((posting) => posting.eventId === original.id)
      ? snapshot.postings
      : [...snapshot.postings, ...originalPostings],
  });
  const withReplacement: LedgerSnapshot = {
    ...snapshot,
    events: snapshot.events.some((event) => event.id === replacement.id)
      ? snapshot.events
      : [...snapshot.events, replacement],
    postings: [
      ...snapshot.postings.filter((posting) => posting.eventId !== replacement.id),
      ...replacementPostings,
    ],
  };
  const correctedView = expenseSideView(replacement, withReplacement);
  const impact = expenseCorrectionImpact(originalPostings, replacementPostings, snapshot);
  return {
    original: originalView,
    corrected: correctedView,
    impact,
    effects: impact,
    classifications: {
      spent: replacement.amountPaise,
      income: 0,
      invested: 0,
      moved: 0,
    },
    warnings: [],
    narrative: impact.map((line) => `${line.label} ${formatInrDelta(paise(line.deltaPaise))}`),
  };
}

export function correctExpense(input: CorrectExpenseInput, snapshot: LedgerSnapshot): PreparedExpenseCorrection {
  const target = snapshot.events.find((event) => event.id === input.targetEventId);
  if (!target) {
    throw new DomainError("transaction_not_correctable", "This transaction can’t be corrected.");
  }
  const targetPostings = postingsFor(target.id, snapshot.postings);
  assertEligibleExpenseCorrection(target, snapshot);

  const rootEventId = correctionRootId(snapshot.transactionCorrections, target.id);
  if (input.rootEventId !== rootEventId) {
    throw new DomainError("transaction_not_correctable", "This transaction can’t be corrected.");
  }

  const occurredOn = isoDate(input.occurredOn);
  if (occurredOn !== target.occurredOn) {
    throw new DomainError("invalid_correction_date", "The date can’t be changed.");
  }

  if (input.allocations.length === 0) {
    throw new DomainError("invalid_expense", "At least one category allocation is required");
  }
  const allocationTotal = sumPaise(input.allocations.map((item) => paise(item.amountPaise)));
  if (allocationTotal !== paise(input.amountPaise)) {
    throw new DomainError("invalid_expense", "Category amounts must add up to the total");
  }

  const material = canonicalizeExpenseCorrectionPayload({
    family: "expense",
    rootEventId,
    targetEventId: target.id,
    amountPaise: input.amountPaise,
    sourceAccountId: input.sourceAccountId,
    occurredOn,
    allocations: input.allocations,
    merchant: input.merchant,
    notes: input.notes,
    reason: input.reason,
  });

  let reversal = buildTransactionReversal(target, targetPostings, input.capturedAt);
  if (input.artifactIds) {
    reversal = assignEventId(reversal.event, reversal.postings, input.artifactIds.reversalEventId);
  }
  assertExactReversal(target, targetPostings, reversal.event, reversal.postings);

  const afterReversal = snapshotAfterReversal(
    snapshot,
    { events: [reversal.event], postings: reversal.postings },
    occurredOn,
  );

  let recorded;
  try {
    recorded = recordExpense(
      {
        occurredOn,
        capturedAt: input.capturedAt,
        accountId: input.sourceAccountId,
        allocations: input.allocations.map((allocation) => ({
          categoryId: allocation.categoryId,
          amountPaise: paise(allocation.amountPaise),
        })),
        merchant: material.merchant,
        notes: material.notes,
        channel: target.channel,
      },
      afterReversal,
    );
  } catch (error) {
    remapReplacementAvailability(error, afterReversal, input.sourceAccountId, paise(input.amountPaise));
  }

  let replacementEvent = recorded.batch.events[0]!;
  let replacementPostings = recorded.batch.postings;
  if (input.artifactIds) {
    const assigned = assignEventId(replacementEvent, replacementPostings, input.artifactIds.replacementEventId);
    replacementEvent = assigned.event;
    replacementPostings = assigned.postings;
  }
  if (replacementEvent.occurredOn !== target.occurredOn) {
    throw new DomainError("invalid_correction_date", "The date can’t be changed.");
  }
  assertConservation("spend_account", { events: [replacementEvent], postings: replacementPostings, openings: [] });

  const preview = buildExpenseCorrectionPreview(
    target,
    targetPostings,
    replacementEvent,
    replacementPostings,
    snapshot,
  );

  return {
    rootEventId,
    targetEventId: target.id,
    targetEvent: target,
    targetPostings,
    reversalEvent: reversal.event,
    reversalPostings: reversal.postings,
    replacementEvent,
    replacementPostings,
    material,
    preview,
  };
}
