import { utcNowIso } from "../domain/calendar/kolkata.js";
import { assertBatchConservation } from "../domain/conservation/validate.js";
import { DomainError, isAccountOpeningPayload, type ProposedBatch } from "../domain/ledger/types.js";
import { eq } from "drizzle-orm";
import type { DbHandles, PostgresHandles, SqliteHandles } from "./handles.js";
import { anyDb, tables } from "./exec.js"; 
import { withPostgresTransaction, withSqliteTransaction } from "./tx.js";

function mappedRows(workspaceId: string, batch: ProposedBatch) {
  return {
    cycles: (batch.billingCycles ?? []).map((cycle) => ({
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
      status: "open" as const,
      ruleSnapshot: JSON.stringify(cycle.ruleSnapshot),
    })),
    openings: batch.openings.map((opening) => ({
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
    instances: (batch.obligationInstances ?? []).map((instance) => ({
      id: instance.id,
      workspaceId,
      templateId: instance.templateId,
      nameSnapshot: instance.nameSnapshot,
      dueOn: instance.dueOn,
      amountPaise: instance.amountPaise,
      prioritySnapshot: instance.prioritySnapshot,
      status: instance.status,
      fundingCycleId: instance.fundingCycleId,
      paidEventId: instance.paidEventId,
    })),
    events: batch.events.map((event) => ({
      id: event.id,
      workspaceId,
      meaning: event.meaning,
      occurredOn: event.occurredOn,
      capturedAt: event.capturedAt,
      amountPaise: event.amountPaise,
      accountId: event.accountId,
      creditCardId: event.creditCardId,
      billingCycleId: event.billingCycleId,
      obligationInstanceId: event.obligationInstanceId ?? null,
      categoryId: event.categoryId,
      channel: event.channel,
      merchant: event.merchant,
      notes: event.notes,
      reversalOfEventId: event.reversalOfEventId,
    })),
    claims: (batch.claims ?? []).map((claim) => ({
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
    shares: (batch.eventShares ?? []).map((share) => ({
      id: share.id,
      workspaceId,
      eventId: share.eventId,
      personId: share.personId,
      amountPaise: share.amountPaise,
      isUser: share.isUser ? 1 : 0,
    })),
    reservations: (batch.reservations ?? []).map((reservation) => ({
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
    allocations: (batch.settlementAllocations ?? []).map((allocation) => ({
      id: allocation.id,
      workspaceId,
      eventId: allocation.eventId,
      claimId: allocation.claimId,
      amountPaise: allocation.amountPaise,
      createsReservation: allocation.createsReservation ? 1 : 0,
      reservationId: allocation.reservationId,
    })),
    claimStatusUpdates: batch.claimStatusUpdates ?? [],
    reservationUpdates: batch.reservationUpdates ?? [],
    ledger: (batch.reservationLedger ?? []).map((entry) => ({
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
    surplus: (batch.surplusCases ?? []).map((item) => ({
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
    surplusCaseUpdates: batch.surplusCaseUpdates ?? [],
    funding: (batch.fundingCycles ?? []).map((cycle) => ({
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
    fundingCycleUpdates: batch.fundingCycleUpdates ?? [],
    obligationInstanceUpdates: batch.obligationInstanceUpdates ?? [],
    postings: batch.postings.map((posting) => ({
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
  };
}

function assertPersistable(batch: ProposedBatch): void {
  if (batch.postings.length > 0 && batch.events.length === 0) {
    throw new DomainError("invalid_batch", "Postings require a financial event");
  }
  if (batch.events.length > 0) {
    assertBatchConservation(batch);
  }
}

function persistBatchSqlite(handles: SqliteHandles, workspaceId: string, batch: ProposedBatch): void {
  const t = tables(handles);
  const rows = mappedRows(workspaceId, batch);
  const write = () => {
    if (rows.cycles.length > 0) anyDb(handles).insert(t.billingCycles).values(rows.cycles).run();
    if (rows.openings.length > 0) anyDb(handles).insert(t.openingPositions).values(rows.openings).run();
    if (rows.instances.length > 0) anyDb(handles).insert(t.obligationInstances).values(rows.instances).run();
    if (rows.events.length > 0) anyDb(handles).insert(t.financialEvents).values(rows.events).run();
    if (rows.claims.length > 0) anyDb(handles).insert(t.claims).values(rows.claims).run();
    if (rows.shares.length > 0) anyDb(handles).insert(t.eventShares).values(rows.shares).run();
    if (rows.reservations.length > 0) anyDb(handles).insert(t.reservations).values(rows.reservations).run();
    if (rows.allocations.length > 0) anyDb(handles).insert(t.settlementAllocations).values(rows.allocations).run();
    for (const patch of rows.claimStatusUpdates) {
      anyDb(handles).update(t.claims).set({ status: patch.status }).where(eq(t.claims.id, patch.id)).run();
    }
    for (const patch of rows.reservationUpdates) {
      anyDb(handles)
        .update(t.reservations)
        .set({
          amountConsumedPaise: patch.amountConsumedPaise,
          amountReleasedPaise: patch.amountReleasedPaise,
          amountReassignedPaise: patch.amountReassignedPaise,
          amountSurplusHeldPaise: patch.amountSurplusHeldPaise,
          status: patch.status,
        })
        .where(eq(t.reservations.id, patch.id))
        .run();
    }
    if (rows.ledger.length > 0) anyDb(handles).insert(t.reservationLedger).values(rows.ledger).run();
    if (rows.surplus.length > 0) anyDb(handles).insert(t.surplusCases).values(rows.surplus).run();
    for (const patch of rows.surplusCaseUpdates) {
      anyDb(handles)
        .update(t.surplusCases)
        .set({
          amountPaise: patch.amountPaise,
          status: patch.status,
          resolution: patch.resolution,
          resolvedAt: patch.resolvedAt,
          resolvedByEventId: patch.resolvedByEventId,
        })
        .where(eq(t.surplusCases.id, patch.id))
        .run();
    }
    if (rows.funding.length > 0) anyDb(handles).insert(t.fundingCycles).values(rows.funding).run();
    for (const patch of rows.fundingCycleUpdates) {
      anyDb(handles)
        .update(t.fundingCycles)
        .set({
          actualArrivalOn: patch.actualArrivalOn,
          actualAmountPaise: patch.actualAmountPaise,
          salaryEventId: patch.salaryEventId,
        })
        .where(eq(t.fundingCycles.id, patch.id))
        .run();
    }
    for (const patch of rows.obligationInstanceUpdates) {
      anyDb(handles)
        .update(t.obligationInstances)
        .set({
          status: patch.status,
          paidEventId: patch.paidEventId,
        })
        .where(eq(t.obligationInstances.id, patch.id))
        .run();
    }
    if (rows.postings.length > 0) anyDb(handles).insert(t.postings).values(rows.postings).run();
  };
  withSqliteTransaction(handles, write);
}

async function persistBatchPostgres(
  handles: PostgresHandles,
  workspaceId: string,
  batch: ProposedBatch,
): Promise<void> {
  const rows = mappedRows(workspaceId, batch);
  await withPostgresTransaction(handles, async (txHandles) => {
    const t = tables(txHandles);
    const db = anyDb(txHandles);
    if (rows.cycles.length > 0) await db.insert(t.billingCycles).values(rows.cycles);
    if (rows.openings.length > 0) await db.insert(t.openingPositions).values(rows.openings);
    if (rows.instances.length > 0) await db.insert(t.obligationInstances).values(rows.instances);
    if (rows.events.length > 0) await db.insert(t.financialEvents).values(rows.events);
    if (rows.claims.length > 0) await db.insert(t.claims).values(rows.claims);
    if (rows.shares.length > 0) await db.insert(t.eventShares).values(rows.shares);
    if (rows.reservations.length > 0) await db.insert(t.reservations).values(rows.reservations);
    if (rows.allocations.length > 0) await db.insert(t.settlementAllocations).values(rows.allocations);
    for (const patch of rows.claimStatusUpdates) {
      await db.update(t.claims).set({ status: patch.status }).where(eq(t.claims.id, patch.id));
    }
    for (const patch of rows.reservationUpdates) {
      await db
        .update(t.reservations)
        .set({
          amountConsumedPaise: patch.amountConsumedPaise,
          amountReleasedPaise: patch.amountReleasedPaise,
          amountReassignedPaise: patch.amountReassignedPaise,
          amountSurplusHeldPaise: patch.amountSurplusHeldPaise,
          status: patch.status,
        })
        .where(eq(t.reservations.id, patch.id));
    }
    if (rows.ledger.length > 0) await db.insert(t.reservationLedger).values(rows.ledger);
    if (rows.surplus.length > 0) await db.insert(t.surplusCases).values(rows.surplus);
    for (const patch of rows.surplusCaseUpdates) {
      await db
        .update(t.surplusCases)
        .set({
          amountPaise: patch.amountPaise,
          status: patch.status,
          resolution: patch.resolution,
          resolvedAt: patch.resolvedAt,
          resolvedByEventId: patch.resolvedByEventId,
        })
        .where(eq(t.surplusCases.id, patch.id));
    }
    if (rows.funding.length > 0) await db.insert(t.fundingCycles).values(rows.funding);
    for (const patch of rows.fundingCycleUpdates) {
      await db
        .update(t.fundingCycles)
        .set({
          actualArrivalOn: patch.actualArrivalOn,
          actualAmountPaise: patch.actualAmountPaise,
          salaryEventId: patch.salaryEventId,
        })
        .where(eq(t.fundingCycles.id, patch.id));
    }
    for (const patch of rows.obligationInstanceUpdates) {
      await db
        .update(t.obligationInstances)
        .set({
          status: patch.status,
          paidEventId: patch.paidEventId,
        })
        .where(eq(t.obligationInstances.id, patch.id));
    }
    if (rows.postings.length > 0) await db.insert(t.postings).values(rows.postings);
  });
}

export async function persistBatch(
  handles: DbHandles,
  workspaceId: string,
  batch: ProposedBatch,
): Promise<void> {
  assertPersistable(batch);
  if (handles.dialect === "sqlite") {
    persistBatchSqlite(handles, workspaceId, batch);
    return;
  }
  await persistBatchPostgres(handles, workspaceId, batch);
}

export type StatementConfirmationPatch = {
  cycleId: string;
  actualStatementAmountPaise: number;
  actualStatementOn: string;
  actualDueOn: string;
};

/** Cycle confirmation + optional excess batch in one financial transaction. */
export async function persistStatementConfirmation(
  handles: DbHandles,
  workspaceId: string,
  patch: StatementConfirmationPatch,
  batch: ProposedBatch,
): Promise<void> {
  assertPersistable(batch);
  if (handles.dialect === "sqlite") {
    withSqliteTransaction(handles, () => {
      const t = tables(handles);
      anyDb(handles)
        .update(t.billingCycles)
        .set({
          actualStatementAmountPaise: patch.actualStatementAmountPaise,
          actualStatementOn: patch.actualStatementOn,
          actualDueOn: patch.actualDueOn,
          status: "statement_confirmed",
        })
        .where(eq(t.billingCycles.id, patch.cycleId))
        .run();
      persistBatchSqlite(handles, workspaceId, batch);
    });
    return;
  }
  await withPostgresTransaction(handles, async (txHandles) => {
    const t = tables(txHandles);
    await anyDb(txHandles)
      .update(t.billingCycles)
      .set({
        actualStatementAmountPaise: patch.actualStatementAmountPaise,
        actualStatementOn: patch.actualStatementOn,
        actualDueOn: patch.actualDueOn,
        status: "statement_confirmed",
      })
      .where(eq(t.billingCycles.id, patch.cycleId));
    await persistBatchPostgres(txHandles, workspaceId, batch);
  });
}
