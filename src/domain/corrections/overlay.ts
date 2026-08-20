import type { IsoDate } from "../calendar/isoDate.js";
import type { LedgerSnapshot, ProposedBatch } from "../ledger/types.js";
import { applyBatchOverlay } from "../engine/overlay.js";

/**
 * Apply a reversal batch in memory so a replacement can be validated against
 * post-reversal available money. Does not persist.
 */
export function snapshotAfterReversal(
  snapshot: LedgerSnapshot,
  reversal: Pick<ProposedBatch, "events" | "postings">,
  asOf: IsoDate,
): LedgerSnapshot {
  return applyBatchOverlay(
    snapshot,
    {
      events: reversal.events,
      postings: reversal.postings,
      openings: [],
    },
    asOf,
  );
}
