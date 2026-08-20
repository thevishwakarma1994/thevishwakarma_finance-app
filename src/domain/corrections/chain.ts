import { DomainError, type FinancialEvent } from "../ledger/types.js";
import type { TransactionCorrectionRecord } from "./types.js";

function byCapturedAt(left: TransactionCorrectionRecord, right: TransactionCorrectionRecord): number {
  if (left.capturedAt === right.capturedAt) return left.id.localeCompare(right.id);
  return left.capturedAt < right.capturedAt ? -1 : 1;
}

export function correctionsForRoot(
  corrections: readonly TransactionCorrectionRecord[],
  rootEventId: string,
): TransactionCorrectionRecord[] {
  return corrections.filter((item) => item.rootEventId === rootEventId).sort(byCapturedAt);
}

export function correctionRootId(
  corrections: readonly TransactionCorrectionRecord[],
  eventId: string,
): string {
  const match = corrections.find(
    (item) =>
      item.rootEventId === eventId ||
      item.targetEventId === eventId ||
      item.reversalEventId === eventId ||
      item.replacementEventId === eventId,
  );
  return match?.rootEventId ?? eventId;
}

export function correctionHistory(
  corrections: readonly TransactionCorrectionRecord[],
  rootEventId: string,
): TransactionCorrectionRecord[] {
  const chain = correctionsForRoot(corrections, rootEventId);
  assertAcyclicCorrectionChain(chain, rootEventId);
  return chain;
}

export function correctionCount(
  corrections: readonly TransactionCorrectionRecord[],
  rootEventId: string,
): number {
  return correctionHistory(corrections, rootEventId).length;
}

export function currentEffectiveLeafId(
  corrections: readonly TransactionCorrectionRecord[],
  rootEventId: string,
): string {
  const chain = correctionHistory(corrections, rootEventId);
  return chain.at(-1)?.replacementEventId ?? rootEventId;
}

export function isCurrentEffectiveLeaf(
  corrections: readonly TransactionCorrectionRecord[],
  eventId: string,
): boolean {
  const rootEventId = correctionRootId(corrections, eventId);
  return currentEffectiveLeafId(corrections, rootEventId) === eventId;
}

export function assertAcyclicCorrectionChain(
  chain: readonly TransactionCorrectionRecord[],
  rootEventId: string,
): void {
  const seenTargets = new Set<string>();
  let expectedTarget = rootEventId;
  const seenEvents = new Set<string>([rootEventId]);
  for (const item of [...chain].sort(byCapturedAt)) {
    if (item.rootEventId !== rootEventId) {
      throw new DomainError("transaction_not_correctable", "This transaction cannot be corrected");
    }
    if (seenTargets.has(item.targetEventId)) {
      throw new DomainError("stale_correction_target", "This transaction was already corrected");
    }
    if (item.targetEventId !== expectedTarget) {
      throw new DomainError("stale_correction_target", "This transaction was already corrected");
    }
    if (
      seenEvents.has(item.reversalEventId) ||
      seenEvents.has(item.replacementEventId) ||
      item.replacementEventId === item.targetEventId ||
      item.reversalEventId === item.targetEventId ||
      item.reversalEventId === item.replacementEventId
    ) {
      throw new DomainError("transaction_not_correctable", "This transaction cannot be corrected");
    }
    seenTargets.add(item.targetEventId);
    seenEvents.add(item.targetEventId);
    seenEvents.add(item.reversalEventId);
    seenEvents.add(item.replacementEventId);
    expectedTarget = item.replacementEventId;
  }
}

export function firstCorrectionMapping(originalEventId: string): {
  rootEventId: string;
  targetEventId: string;
} {
  return { rootEventId: originalEventId, targetEventId: originalEventId };
}

export function nextCorrectionMapping(
  corrections: readonly TransactionCorrectionRecord[],
  originalEventId: string,
): { rootEventId: string; targetEventId: string } {
  const rootEventId = correctionRootId(corrections, originalEventId);
  const existing = correctionsForRoot(corrections, rootEventId);
  if (existing.length === 0) {
    return firstCorrectionMapping(originalEventId);
  }
  return {
    rootEventId,
    targetEventId: currentEffectiveLeafId(corrections, rootEventId),
  };
}

export function assertNewCorrectionLink(
  corrections: readonly TransactionCorrectionRecord[],
  input: {
    rootEventId: string;
    targetEventId: string;
    reversalEventId: string;
    replacementEventId: string;
  },
): void {
  const chain = correctionsForRoot(corrections, input.rootEventId);
  assertAcyclicCorrectionChain(chain, input.rootEventId);
  const expected = nextCorrectionMapping(corrections, input.rootEventId);
  if (input.rootEventId !== expected.rootEventId || input.targetEventId !== expected.targetEventId) {
    throw new DomainError("stale_correction_target", "This transaction was already corrected");
  }
  if (corrections.some((item) => item.targetEventId === input.targetEventId)) {
    throw new DomainError("stale_correction_target", "This transaction was already corrected");
  }
  const chainEventIds = new Set<string>([input.rootEventId]);
  for (const item of chain) {
    chainEventIds.add(item.targetEventId);
    chainEventIds.add(item.reversalEventId);
    chainEventIds.add(item.replacementEventId);
  }
  if (chainEventIds.has(input.replacementEventId) || chainEventIds.has(input.reversalEventId)) {
    throw new DomainError("transaction_not_correctable", "This transaction cannot be corrected");
  }
  if (
    input.replacementEventId === input.targetEventId ||
    input.reversalEventId === input.targetEventId ||
    input.reversalEventId === input.replacementEventId
  ) {
    throw new DomainError("transaction_not_correctable", "This transaction cannot be corrected");
  }
}

export function supersededEventIds(corrections: readonly TransactionCorrectionRecord[]): Set<string> {
  return new Set(corrections.map((item) => item.targetEventId));
}

export function reversalEventIds(corrections: readonly TransactionCorrectionRecord[]): Set<string> {
  return new Set(corrections.map((item) => item.reversalEventId));
}

export function logicalEventIdsFor(
  eventId: string,
  corrections: readonly TransactionCorrectionRecord[],
): Set<string> {
  const rootEventId = correctionRootId(corrections, eventId);
  const ids = new Set<string>([rootEventId]);
  for (const item of correctionHistory(corrections, rootEventId)) {
    ids.add(item.targetEventId);
    ids.add(item.reversalEventId);
    ids.add(item.replacementEventId);
  }
  return ids;
}

export function eventInCorrectionChain(
  event: Pick<FinancialEvent, "id">,
  corrections: readonly TransactionCorrectionRecord[],
): boolean {
  return correctionRootId(corrections, event.id) !== event.id || corrections.some((item) => item.rootEventId === event.id);
}
