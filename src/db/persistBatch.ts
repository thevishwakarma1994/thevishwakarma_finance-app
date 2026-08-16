import { utcNowIso } from "../domain/calendar/kolkata.js";
import { assertBatchConservation } from "../domain/conservation/validate.js";
import { DomainError, type ProposedBatch } from "../domain/ledger/types.js";
import { financialEvents, openingPositions, postings } from "./schema.js";
import type { SqliteHandles } from "./client.js";
import { withTransaction } from "./tx.js";

export function persistBatch(
  handles: SqliteHandles,
  workspaceId: string,
  batch: ProposedBatch,
): void {
  if (batch.postings.length > 0 && batch.events.length === 0) {
    throw new DomainError("invalid_batch", "Postings require a financial event");
  }
  if (batch.events.length > 0) {
    assertBatchConservation(batch);
  }

  withTransaction(handles, () => {
    if (batch.openings.length > 0) {
      handles.db
        .insert(openingPositions)
        .values(
          batch.openings.map((opening) => ({
            id: opening.id,
            workspaceId,
            effectiveOn: opening.effectiveOn,
            kind: opening.kind,
            subjectId: opening.subjectId,
            payload: JSON.stringify({ balancePaise: opening.payload.balancePaise }),
            createdAt: utcNowIso(),
          })),
        )
        .run();
    }

    if (batch.events.length > 0) {
      handles.db
        .insert(financialEvents)
        .values(
          batch.events.map((event) => ({
            id: event.id,
            workspaceId,
            meaning: event.meaning,
            occurredOn: event.occurredOn,
            capturedAt: event.capturedAt,
            amountPaise: event.amountPaise,
            accountId: event.accountId,
            categoryId: event.categoryId,
            channel: event.channel,
            merchant: event.merchant,
            notes: event.notes,
            reversalOfEventId: event.reversalOfEventId,
          })),
        )
        .run();
    }

    if (batch.postings.length > 0) {
      handles.db
        .insert(postings)
        .values(
          batch.postings.map((posting) => ({
            id: posting.id,
            workspaceId,
            eventId: posting.eventId,
            amountPaise: posting.amountPaise,
            accountId: posting.accountId,
            pnl: posting.pnl,
            categoryId: posting.categoryId,
          })),
        )
        .run();
    }
  });
}
