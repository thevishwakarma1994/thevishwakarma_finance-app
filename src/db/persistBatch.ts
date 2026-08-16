import { utcNowIso } from "../domain/calendar/kolkata.js";
import { assertBatchConservation } from "../domain/conservation/validate.js";
import { DomainError, isAccountOpeningPayload, type ProposedBatch } from "../domain/ledger/types.js";
import { eq } from "drizzle-orm";
import {
  billingCycles,
  claims,
  eventShares,
  financialEvents,
  fundingCycles,
  openingPositions,
  postings,
  reservationLedger,
  reservations,
  settlementAllocations,
  surplusCases,
} from "./schema.js";
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
            payload: JSON.stringify(
              isAccountOpeningPayload(opening.payload)
                ? { balancePaise: opening.payload.balancePaise }
                : {
                    direction: opening.payload.direction,
                    amountPaise: opening.payload.amountPaise,
                    note: opening.payload.note ?? null,
                  },
            ),
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

    const nextClaims = batch.claims ?? [];
    if (nextClaims.length > 0) {
      handles.db
        .insert(claims)
        .values(
          nextClaims.map((claim) => ({
            id: claim.id,
            workspaceId,
            personId: claim.personId,
            direction: claim.direction,
            kind: claim.kind,
            originalAmountPaise: claim.originalAmountPaise,
            originatingEventId: claim.originatingEventId,
            openingPositionId: claim.openingPositionId,
            billingCycleId: claim.billingCycleId,
            obligationRefType: null,
            obligationRefId: null,
            note: claim.note,
            status: claim.status,
          })),
        )
        .run();
    }

    const shares = batch.eventShares ?? [];
    if (shares.length > 0) {
      handles.db
        .insert(eventShares)
        .values(
          shares.map((share) => ({
            id: share.id,
            workspaceId,
            eventId: share.eventId,
            personId: share.personId,
            amountPaise: share.amountPaise,
            isUser: share.isUser ? 1 : 0,
          })),
        )
        .run();
    }

    const nextReservations = batch.reservations ?? [];
    if (nextReservations.length > 0) {
      handles.db
        .insert(reservations)
        .values(
          nextReservations.map((reservation) => ({
            id: reservation.id,
            workspaceId,
            sourceAccountId: reservation.sourceAccountId,
            amountOriginalPaise: reservation.amountOriginalPaise,
            amountConsumedPaise: reservation.amountConsumedPaise,
            amountReleasedPaise: reservation.amountReleasedPaise,
            amountReassignedPaise: reservation.amountReassignedPaise,
            amountSurplusHeldPaise: reservation.amountSurplusHeldPaise,
            status: reservation.status,
            obligationRefType: reservation.obligationRef.type,
            obligationRefId: reservation.obligationRef.id,
            originatingEventId: reservation.originatingEventId,
            originatingClaimId: reservation.originatingClaimId,
            createdOn: reservation.createdOn,
          })),
        )
        .run();
    }

    const allocations = batch.settlementAllocations ?? [];
    if (allocations.length > 0) {
      handles.db
        .insert(settlementAllocations)
        .values(
          allocations.map((allocation) => ({
            id: allocation.id,
            workspaceId,
            eventId: allocation.eventId,
            claimId: allocation.claimId,
            amountPaise: allocation.amountPaise,
            createsReservation: allocation.createsReservation ? 1 : 0,
            reservationId: allocation.reservationId,
          })),
        )
        .run();
    }

    for (const patch of batch.claimStatusUpdates ?? []) {
      handles.db.update(claims).set({ status: patch.status }).where(eq(claims.id, patch.id)).run();
    }

    for (const patch of batch.reservationUpdates ?? []) {
      handles.db
        .update(reservations)
        .set({
          amountConsumedPaise: patch.amountConsumedPaise,
          amountReleasedPaise: patch.amountReleasedPaise,
          amountReassignedPaise: patch.amountReassignedPaise,
          amountSurplusHeldPaise: patch.amountSurplusHeldPaise,
          status: patch.status,
        })
        .where(eq(reservations.id, patch.id))
        .run();
    }

    const ledger = batch.reservationLedger ?? [];
    if (ledger.length > 0) {
      handles.db
        .insert(reservationLedger)
        .values(
          ledger.map((entry) => ({
            id: entry.id,
            workspaceId,
            reservationId: entry.reservationId,
            eventId: entry.eventId,
            deltaConsumedPaise: entry.deltaConsumedPaise,
            deltaReleasedPaise: entry.deltaReleasedPaise,
            deltaReassignedPaise: entry.deltaReassignedPaise,
            deltaSurplusHeldPaise: entry.deltaSurplusHeldPaise,
            createdAt: entry.createdAt,
          })),
        )
        .run();
    }

    const nextSurplus = batch.surplusCases ?? [];
    if (nextSurplus.length > 0) {
      handles.db
        .insert(surplusCases)
        .values(
          nextSurplus.map((item) => ({
            id: item.id,
            workspaceId,
            amountPaise: item.amountPaise,
            kind: item.kind,
            sourceAccountId: item.sourceAccountId,
            personId: item.personId,
            reservationId: item.reservationId,
            eventId: item.eventId,
            explanation: item.explanation,
            status: item.status,
            resolution: item.resolution,
            resolvedAt: item.resolvedAt,
            resolvedByEventId: item.resolvedByEventId,
          })),
        )
        .run();
    }

    for (const patch of batch.surplusCaseUpdates ?? []) {
      handles.db
        .update(surplusCases)
        .set({
          amountPaise: patch.amountPaise,
          status: patch.status,
          resolution: patch.resolution,
          resolvedAt: patch.resolvedAt,
          resolvedByEventId: patch.resolvedByEventId,
        })
        .where(eq(surplusCases.id, patch.id))
        .run();
    }

    const nextFunding = batch.fundingCycles ?? [];
    if (nextFunding.length > 0) {
      handles.db
        .insert(fundingCycles)
        .values(
          nextFunding.map((cycle) => ({
            id: cycle.id,
            workspaceId,
            year: cycle.year,
            month: cycle.month,
            expectedWindowStart: cycle.expectedWindowStart,
            expectedWindowEnd: cycle.expectedWindowEnd,
            expectedAmountSnapshot: cycle.expectedAmountSnapshot,
            actualArrivalOn: cycle.actualArrivalOn,
            actualAmountPaise: cycle.actualAmountPaise,
            salaryEventId: cycle.salaryEventId,
          })),
        )
        .run();
    }

    for (const patch of batch.fundingCycleUpdates ?? []) {
      handles.db
        .update(fundingCycles)
        .set({
          actualArrivalOn: patch.actualArrivalOn,
          actualAmountPaise: patch.actualAmountPaise,
          salaryEventId: patch.salaryEventId,
        })
        .where(eq(fundingCycles.id, patch.id))
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
            claimId: posting.claimId,
          })),
        )
        .run();
    }
  });
}
