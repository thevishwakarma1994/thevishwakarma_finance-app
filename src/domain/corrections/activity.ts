import type { FinancialEvent, LedgerSnapshot, Posting } from "../ledger/types.js";
import {
  correctionCount,
  correctionHistory,
  correctionRootId,
  currentEffectiveLeafId,
  reversalEventIds,
  supersededEventIds,
} from "./chain.js";
import type { TransactionCorrectionRecord } from "./types.js";

export type FoldedActivityIdentity = {
  rootEventId: string;
  effectiveEventId: string;
  corrected: boolean;
  correctionCount: number;
};

export function activityIdentityFor(
  eventId: string,
  corrections: readonly TransactionCorrectionRecord[],
): FoldedActivityIdentity {
  const rootEventId = correctionRootId(corrections, eventId);
  const effectiveEventId = currentEffectiveLeafId(corrections, rootEventId);
  const count = correctionCount(corrections, rootEventId);
  return {
    rootEventId,
    effectiveEventId,
    corrected: count > 0,
    correctionCount: count,
  };
}

export function shouldShowInOrdinaryActivity(
  event: Pick<FinancialEvent, "id" | "meaning">,
  corrections: readonly TransactionCorrectionRecord[],
): boolean {
  if (event.meaning === "transaction_reversal") return false;
  if (reversalEventIds(corrections).has(event.id)) return false;
  if (supersededEventIds(corrections).has(event.id)) return false;
  return true;
}

export type TransactionCorrectionDetail = {
  rootEvent: FinancialEvent;
  effectiveEvent: FinancialEvent;
  correctionCount: number;
  history: Array<{
    correction: TransactionCorrectionRecord;
    targetEvent: FinancialEvent;
    reversalEvent: FinancialEvent;
    replacementEvent: FinancialEvent;
  }>;
};

export function transactionDetailFromSnapshot(
  snapshot: LedgerSnapshot,
  eventId: string,
): TransactionCorrectionDetail | null {
  const rootEventId = correctionRootId(snapshot.transactionCorrections, eventId);
  const rootEvent = snapshot.events.find((event) => event.id === rootEventId);
  if (!rootEvent) return null;
  const effectiveEventId = currentEffectiveLeafId(snapshot.transactionCorrections, rootEventId);
  const effectiveEvent = snapshot.events.find((event) => event.id === effectiveEventId);
  if (!effectiveEvent) return null;
  const history = correctionHistory(snapshot.transactionCorrections, rootEventId).map((correction) => {
    const targetEvent = snapshot.events.find((event) => event.id === correction.targetEventId);
    const reversalEvent = snapshot.events.find((event) => event.id === correction.reversalEventId);
    const replacementEvent = snapshot.events.find((event) => event.id === correction.replacementEventId);
    if (!targetEvent || !reversalEvent || !replacementEvent) {
      throw new Error("Correction history is missing events");
    }
    return { correction, targetEvent, reversalEvent, replacementEvent };
  });
  return {
    rootEvent,
    effectiveEvent,
    correctionCount: history.length,
    history,
  };
}

export function postingsForEvent(snapshot: LedgerSnapshot, eventId: string): Posting[] {
  return snapshot.postings.filter((posting) => posting.eventId === eventId);
}
