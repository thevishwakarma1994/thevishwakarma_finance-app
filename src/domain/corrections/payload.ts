import { newId } from "../ids.js";

export type ExpenseCorrectionAllocation = {
  categoryId: string;
  amountPaise: number;
};

export type CanonicalExpenseCorrectionPayload = {
  family: "expense";
  rootEventId: string;
  targetEventId: string;
  amountPaise: number;
  sourceAccountId: string;
  occurredOn: string;
  allocations: ExpenseCorrectionAllocation[];
  merchant: string | null | undefined;
  notes: string | null | undefined;
  reason: string | null | undefined;
};

export type CanonicalOtherIncomeCorrectionPayload = {
  family: "other_income";
  rootEventId: string;
  targetEventId: string;
  amountPaise: number;
  sourceAccountId: string;
  occurredOn: string;
  notes: string | null | undefined;
  reason: string | null | undefined;
};

export type CanonicalCorrectionPayload =
  | CanonicalExpenseCorrectionPayload
  | CanonicalOtherIncomeCorrectionPayload;

export function normalizeCorrectionText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function sortAllocations(allocations: readonly ExpenseCorrectionAllocation[]): ExpenseCorrectionAllocation[] {
  return [...allocations]
    .map((item) => ({ categoryId: item.categoryId, amountPaise: item.amountPaise }))
    .sort((left, right) => {
      if (left.categoryId === right.categoryId) return left.amountPaise - right.amountPaise;
      return left.categoryId.localeCompare(right.categoryId);
    });
}

export function canonicalizeExpenseCorrectionPayload(
  input: CanonicalExpenseCorrectionPayload,
): CanonicalExpenseCorrectionPayload {
  return {
    family: "expense",
    rootEventId: input.rootEventId,
    targetEventId: input.targetEventId,
    amountPaise: input.amountPaise,
    sourceAccountId: input.sourceAccountId,
    occurredOn: input.occurredOn,
    allocations: sortAllocations(input.allocations),
    merchant: normalizeCorrectionText(input.merchant),
    notes: normalizeCorrectionText(input.notes),
    reason: normalizeCorrectionText(input.reason),
  };
}

export function canonicalizeOtherIncomeCorrectionPayload(
  input: CanonicalOtherIncomeCorrectionPayload,
): CanonicalOtherIncomeCorrectionPayload {
  return {
    family: "other_income",
    rootEventId: input.rootEventId,
    targetEventId: input.targetEventId,
    amountPaise: input.amountPaise,
    sourceAccountId: input.sourceAccountId,
    occurredOn: input.occurredOn,
    notes: normalizeCorrectionText(input.notes),
    reason: normalizeCorrectionText(input.reason),
  };
}

export function canonicalizeCorrectionPayload(input: CanonicalCorrectionPayload): CanonicalCorrectionPayload {
  if (input.family === "expense") return canonicalizeExpenseCorrectionPayload(input);
  return canonicalizeOtherIncomeCorrectionPayload(input);
}

export function correctionPayloadsEqual(
  left: CanonicalCorrectionPayload,
  right: CanonicalCorrectionPayload,
): boolean {
  return JSON.stringify(canonicalizeCorrectionPayload(left)) === JSON.stringify(canonicalizeCorrectionPayload(right));
}

/**
 * 16C1 must generate reversal/replacement IDs only after
 * `resolveCorrectionCommandReplay` returns `{ status: "new" }`.
 * Do not derive IDs from commandId — retries reuse stored IDs.
 */
export function newCorrectionArtifactIds(): { reversalEventId: string; replacementEventId: string } {
  return { reversalEventId: newId(), replacementEventId: newId() };
}
