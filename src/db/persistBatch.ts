import { utcNowIso } from "../domain/calendar/kolkata.js";
import { assertBatchConservation } from "../domain/conservation/validate.js";
import { DomainError, type ProposedBatch } from "../domain/ledger/types.js";
import { billingCycles, financialEvents, openingPositions, postings } from "./schema.js";
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
    const cycles = batch.billingCycles ?? [];
    if (cycles.length > 0) {
      handles.db
        .insert(billingCycles)
        .values(
          cycles.map((cycle) => ({
            id: cycle.id,
            workspaceId,
            creditCardId: cycle.creditCardId,
            purchaseWindowStart: cycle.purchaseWindowStart,
            purchaseWindowEnd: cycle.purchaseWindowEnd,
            expectedStatementOn: cycle.expectedStatementOn,
            actualStatementOn: cycle.actualStatementOn,
            expectedDueOn: cycle.expectedDueOn,
            actualDueOn: cycle.actualDueOn,
            actualStatementAmountPaise: cycle.actualStatementAmountPaise,
            status: "open",
            ruleSnapshot: JSON.stringify(cycle.ruleSnapshot),
          })),
        )
        .run();
    }

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
            creditCardId: event.creditCardId,
            billingCycleId: event.billingCycleId,
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
            creditCardId: posting.creditCardId,
            pnl: posting.pnl,
            categoryId: posting.categoryId,
            billingCycleId: posting.billingCycleId,
          })),
        )
        .run();
    }
  });
}
