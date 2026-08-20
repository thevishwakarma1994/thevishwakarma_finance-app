import { paise } from "../money/paise.js";
import { formatInrDelta } from "../money/inr.js";
import { isoDate } from "../calendar/isoDate.js";
import { assertConservation } from "../conservation/validate.js";
import { DomainError, type FinancialEvent, type LedgerSnapshot, type Posting } from "../ledger/types.js";
import {
  assertEligibleOtherIncomeCorrection,
  assertCorrectionFinalLiquidity,
} from "../corrections/eligibility.js";
import { correctionRootId } from "../corrections/chain.js";
import { buildTransactionReversal, assertExactReversal } from "../corrections/reversal.js";
import { snapshotAfterReversal } from "../corrections/overlay.js";
import { applyBatchOverlay } from "../engine/overlay.js";
import {
  canonicalizeOtherIncomeCorrectionPayload,
  type CanonicalOtherIncomeCorrectionPayload,
} from "../corrections/payload.js";
import { recordIncome } from "./recordIncome.js";

export type OtherIncomeCorrectionSideView = {
  amountPaise: number;
  accountId: string | null;
  accountName: string | null;
  merchant: string | null;
  notes: string | null;
  occurredOn: string;
  categories: { id: string | null; name: string; amountPaise: number }[];
};

export type OtherIncomeCorrectionPreview = {
  original: OtherIncomeCorrectionSideView;
  corrected: OtherIncomeCorrectionSideView;
  impact: { kind: string; label: string; deltaPaise: number }[];
  effects: { kind: string; label: string; deltaPaise: number }[];
  classifications: { spent: number; income: number; invested: number; moved: number };
  warnings: string[];
  narrative: string[];
};

export type CorrectOtherIncomeInput = {
  commandId: string;
  rootEventId: string;
  targetEventId: string;
  amountPaise: number;
  destinationAccountId: string;
  occurredOn: string;
  notes?: string | null;
  reason?: string | null;
  capturedAt: string;
  artifactIds?: { reversalEventId: string; replacementEventId: string };
};

export type PreparedOtherIncomeCorrection = {
  rootEventId: string;
  targetEventId: string;
  targetEvent: FinancialEvent;
  targetPostings: Posting[];
  reversalEvent: FinancialEvent;
  reversalPostings: Posting[];
  replacementEvent: FinancialEvent;
  replacementPostings: Posting[];
  material: CanonicalOtherIncomeCorrectionPayload;
  preview: OtherIncomeCorrectionPreview;
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

export function otherIncomeSideView(event: FinancialEvent, snapshot: LedgerSnapshot): OtherIncomeCorrectionSideView {
  const account =
    event.accountId ? snapshot.accounts.find((item) => item.id === event.accountId) : undefined;
  return {
    amountPaise: event.amountPaise,
    accountId: event.accountId,
    accountName: account?.displayName ?? null,
    merchant: null,
    notes: event.notes,
    occurredOn: event.occurredOn,
    categories: [],
  };
}

export function otherIncomeCorrectionImpact(
  originalPostings: readonly Posting[],
  replacementPostings: readonly Posting[],
  snapshot: LedgerSnapshot,
): { kind: string; label: string; deltaPaise: number }[] {
  const accountDeltas = new Map<string, number>();
  let incomeDelta = 0;
  for (const posting of originalPostings) {
    if (posting.accountId) {
      accountDeltas.set(posting.accountId, (accountDeltas.get(posting.accountId) ?? 0) - posting.amountPaise);
    }
    if (posting.pnl === "income_other") {
      incomeDelta -= posting.amountPaise;
    }
  }
  for (const posting of replacementPostings) {
    if (posting.accountId) {
      accountDeltas.set(posting.accountId, (accountDeltas.get(posting.accountId) ?? 0) + posting.amountPaise);
    }
    if (posting.pnl === "income_other") {
      incomeDelta += posting.amountPaise;
    }
  }

  const impact: { kind: string; label: string; deltaPaise: number }[] = [];
  for (const [accountId, deltaPaise] of [...accountDeltas.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (deltaPaise === 0) continue;
    impact.push({
      kind: "account",
      label: snapshot.accounts.find((account) => account.id === accountId)?.displayName ?? "Account",
      deltaPaise,
    });
  }
  if (incomeDelta !== 0) {
    impact.push({ kind: "income", label: "Other income", deltaPaise: incomeDelta });
  }
  return impact;
}

export function negativelyAffectedAccountIds(
  originalPostings: readonly Posting[],
  replacementPostings: readonly Posting[],
): string[] {
  const deltas = new Map<string, number>();
  for (const posting of originalPostings) {
    if (!posting.accountId) continue;
    deltas.set(posting.accountId, (deltas.get(posting.accountId) ?? 0) - posting.amountPaise);
  }
  for (const posting of replacementPostings) {
    if (!posting.accountId) continue;
    deltas.set(posting.accountId, (deltas.get(posting.accountId) ?? 0) + posting.amountPaise);
  }
  return [...deltas.entries()].filter(([, delta]) => delta < 0).map(([accountId]) => accountId);
}

export function buildOtherIncomeCorrectionPreview(
  original: FinancialEvent,
  originalPostings: readonly Posting[],
  replacement: FinancialEvent,
  replacementPostings: readonly Posting[],
  snapshot: LedgerSnapshot,
): OtherIncomeCorrectionPreview {
  const originalView = otherIncomeSideView(original, {
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
  const correctedView = otherIncomeSideView(replacement, withReplacement);
  const impact = otherIncomeCorrectionImpact(originalPostings, replacementPostings, snapshot);
  return {
    original: originalView,
    corrected: correctedView,
    impact,
    effects: impact,
    classifications: {
      spent: 0,
      income: replacement.amountPaise,
      invested: 0,
      moved: 0,
    },
    warnings: [],
    narrative: impact.map((line) => `${line.label} ${formatInrDelta(paise(line.deltaPaise))}`),
  };
}

export function correctOtherIncome(
  input: CorrectOtherIncomeInput,
  snapshot: LedgerSnapshot,
): PreparedOtherIncomeCorrection {
  const target = snapshot.events.find((event) => event.id === input.targetEventId);
  if (!target) {
    throw new DomainError("transaction_not_correctable", "This transaction can’t be corrected.");
  }
  const targetPostings = postingsFor(target.id, snapshot.postings);
  assertEligibleOtherIncomeCorrection(target, snapshot);

  const rootEventId = correctionRootId(snapshot.transactionCorrections, target.id);
  if (input.rootEventId !== rootEventId) {
    throw new DomainError("transaction_not_correctable", "This transaction can’t be corrected.");
  }

  const occurredOn = isoDate(input.occurredOn);
  if (occurredOn !== target.occurredOn) {
    throw new DomainError("invalid_correction_date", "The date can’t be changed.");
  }

  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new DomainError("invalid_amount", "Income must be greater than zero");
  }

  const material = canonicalizeOtherIncomeCorrectionPayload({
    family: "other_income",
    rootEventId,
    targetEventId: target.id,
    amountPaise: input.amountPaise,
    sourceAccountId: input.destinationAccountId,
    occurredOn,
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

  const recorded = recordIncome(
    {
      occurredOn,
      capturedAt: input.capturedAt,
      amountPaise: paise(input.amountPaise),
      accountId: input.destinationAccountId,
      kind: "other",
      notes: material.notes,
    },
    afterReversal,
  );

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
  if (replacementEvent.meaning !== "income" || replacementEvent.fundingCycleId) {
    throw new DomainError("transaction_not_correctable", "This transaction can’t be corrected.");
  }
  if (replacementPostings.some((posting) => posting.pnl === "income_salary")) {
    throw new DomainError("transaction_not_correctable", "This transaction can’t be corrected.");
  }
  assertConservation("income", { events: [replacementEvent], postings: replacementPostings, openings: [] });

  const afterCorrection = applyBatchOverlay(
    afterReversal,
    { events: [replacementEvent], postings: replacementPostings, openings: [] },
    occurredOn,
  );
  assertCorrectionFinalLiquidity(
    afterCorrection,
    negativelyAffectedAccountIds(targetPostings, replacementPostings),
  );

  const preview = buildOtherIncomeCorrectionPreview(
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
