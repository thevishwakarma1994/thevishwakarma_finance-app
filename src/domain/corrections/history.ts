import type { IsoDate } from "../calendar/isoDate.js";
import type { FinancialEvent, Posting } from "../ledger/types.js";
import type { TransactionCorrectionRecord } from "./types.js";

/** Calendar-date cutoff: a correction is effective when `correctedOn <= asOf`. */
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
