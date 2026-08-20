import type { IsoDate } from "../calendar/isoDate.js";
import type { FinancialEvent, Posting } from "../ledger/types.js";
import type { TransactionCorrectionRecord } from "./types.js";

/**
 * 16C0/16C1 historical contract — not general ledger reconstruction.
 *
 * `asOf` only hides reversal/replacement artifacts whose `correctedOn` is after
 * the cutoff. Unrelated ordinary events are not filtered by occurredOn.
 * 16C1 must not correct dates or cross months. Do not treat this as as-of
 * time-travel for the rest of the ledger.
 */
export function correctionsEffectiveAsOf(
  corrections: readonly TransactionCorrectionRecord[],
  asOf: IsoDate | string,
): TransactionCorrectionRecord[] {
  return corrections.filter((item) => item.correctedOn <= asOf);
}

/**
 * Reversal and replacement events belonging to corrections that have not
 * occurred yet as of `asOf`. Originals stay visible.
 */
export function futureCorrectionArtifactIds(
  corrections: readonly TransactionCorrectionRecord[],
  asOf: IsoDate | string,
): Set<string> {
  const hidden = new Set<string>();
  for (const item of corrections) {
    if (item.correctedOn <= asOf) continue;
    hidden.add(item.reversalEventId);
    hidden.add(item.replacementEventId);
  }
  return hidden;
}

export function excludeFutureCorrectionArtifacts<TEvent extends Pick<FinancialEvent, "id">, TPosting extends Pick<Posting, "eventId">>(
  events: readonly TEvent[],
  postings: readonly TPosting[],
  corrections: readonly TransactionCorrectionRecord[],
  asOf: IsoDate | string,
): {
  events: TEvent[];
  postings: TPosting[];
  corrections: TransactionCorrectionRecord[];
} {
  const hidden = futureCorrectionArtifactIds(corrections, asOf);
  return {
    events: events.filter((event) => !hidden.has(event.id)),
    postings: postings.filter((posting) => !hidden.has(posting.eventId)),
    corrections: correctionsEffectiveAsOf(corrections, asOf),
  };
}
