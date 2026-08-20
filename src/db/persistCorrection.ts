import { eq } from "drizzle-orm";
import { isoDate } from "../domain/calendar/isoDate.js";
import { newId } from "../domain/ids.js";
import {
  DomainError,
  type FinancialEvent,
  type Posting,
  type ProposedBatch,
} from "../domain/ledger/types.js";
import { assertConservation } from "../domain/conservation/validate.js";
import { assertExactReversal } from "../domain/corrections/reversal.js";
import { assertNewCorrectionLink } from "../domain/corrections/chain.js";
import { replayCorrectionOrConflict } from "../domain/corrections/idempotency.js";
import {
  canonicalizeCorrectionPayload,
  correctionPayloadsEqual,
  type CanonicalCorrectionPayload,
} from "../domain/corrections/payload.js";
import type { CorrectionCommandIdentity, TransactionCorrectionRecord } from "../domain/corrections/types.js";
import type { DbHandles } from "./handles.js";
import { anyDb, queryAll, queryGet, tables } from "./exec.js";
import { persistPreparedBatch } from "./persistBatch.js";
import { withPostgresTransaction, withSqliteImmediateTransaction } from "./tx.js";
import { fromStoredPaise } from "./storedPaise.js";

export type CorrectionPersistFailAfter =
  | "reversal_event"
  | "reversal_postings"
  | "replacement_event"
  | "replacement_postings"
  | "correction_row";

export type PersistAtomicCorrectionInput = {
  commandId: string;
  rootEventId: string;
  targetEventId: string;
  targetEvent: FinancialEvent;
  targetPostings: readonly Posting[];
  reversalEvent: FinancialEvent;
  reversalPostings: readonly Posting[];
  replacementEvent: FinancialEvent;
  replacementPostings: readonly Posting[];
  correctedOn: string;
  capturedAt: string;
  reason?: string | null;
  /** Canonical 16C1 payload. Compared on retry instead of generated event IDs. */
  material?: CanonicalCorrectionPayload;
  extra?: Omit<ProposedBatch, "events" | "postings" | "openings" | "transactionCorrections"> & {
    openings?: ProposedBatch["openings"];
  };
  /** Test-only: throw after this persist stage so the outer transaction rolls back. */
  failAfter?: CorrectionPersistFailAfter;
};

export type PersistAtomicCorrectionResult = {
  correction: TransactionCorrectionRecord;
  replayed: boolean;
};

export type CorrectionCommandReplay =
  | { status: "replay"; correction: TransactionCorrectionRecord }
  | { status: "new" };

function uniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String((error as { code?: unknown }).code) : "";
  const message = "message" in error ? String((error as { message?: unknown }).message) : "";
  return (
    code === "23505" ||
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT" ||
    message.includes("UNIQUE") ||
    message.includes("unique constraint")
  );
}

function unknownTransaction(): DomainError {
  return new DomainError("transaction_not_correctable", "This transaction cannot be corrected");
}

type EventRow = {
  id: string;
  workspaceId: string;
  meaning: FinancialEvent["meaning"];
  occurredOn: string;
  capturedAt: string;
  amountPaise: number;
  accountId: string | null;
  creditCardId: string | null;
  billingCycleId: string | null;
  obligationInstanceId: string | null;
  categoryId: string | null;
  channel: string | null;
  merchant: string | null;
  notes: string | null;
  reversalOfEventId: string | null;
};

function toFinancialEvent(row: EventRow): FinancialEvent {
  return {
    id: row.id,
    meaning: row.meaning,
    occurredOn: isoDate(row.occurredOn),
    capturedAt: row.capturedAt,
    amountPaise: fromStoredPaise(row.amountPaise),
    accountId: row.accountId,
    creditCardId: row.creditCardId,
    loanId: null,
    billingCycleId: row.billingCycleId,
    fundingCycleId: null,
    obligationInstanceId: row.obligationInstanceId,
    categoryId: row.categoryId,
    channel: row.channel,
    merchant: row.merchant,
    notes: row.notes,
    reversalOfEventId: row.reversalOfEventId,
  };
}

async function loadEventRow(handles: DbHandles, eventId: string): Promise<EventRow | undefined> {
  const t = tables(handles);
  return queryGet<EventRow>(
    handles,
    anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, eventId)),
  );
}

async function loadOwnedEvent(handles: DbHandles, workspaceId: string, eventId: string): Promise<FinancialEvent> {
  const row = await loadEventRow(handles, eventId);
  if (!row || row.workspaceId !== workspaceId) {
    throw unknownTransaction();
  }
  return toFinancialEvent(row);
}

async function assertNewEventIdAvailable(
  handles: DbHandles,
  workspaceId: string,
  eventId: string,
): Promise<void> {
  const row = await loadEventRow(handles, eventId);
  if (!row) return;
  if (row.workspaceId !== workspaceId) {
    throw new DomainError("idempotency_conflict", "Command ID conflict");
  }
  throw new DomainError("idempotency_conflict", "Command ID conflict");
}

async function loadOwnedPostings(
  handles: DbHandles,
  workspaceId: string,
  eventId: string,
): Promise<Posting[]> {
  const t = tables(handles);
  const rows = await queryAll<{
    id: string;
    workspaceId: string;
    eventId: string;
    amountPaise: number;
    accountId: string | null;
    creditCardId: string | null;
    pnl: Posting["pnl"];
    categoryId: string | null;
    billingCycleId: string | null;
    claimId: string | null;
  }>(handles, anyDb(handles).select().from(t.postings).where(eq(t.postings.eventId, eventId)));
  if (rows.some((row) => row.workspaceId !== workspaceId)) {
    throw unknownTransaction();
  }
  return rows.map((row) => ({
    id: row.id,
    eventId: row.eventId,
    amountPaise: fromStoredPaise(row.amountPaise),
    accountId: row.accountId,
    creditCardId: row.creditCardId,
    loanId: null,
    pnl: row.pnl,
    categoryId: row.categoryId,
    claimId: row.claimId,
    billingCycleId: row.billingCycleId,
  }));
}

async function loadCorrectionByCommandId(
  handles: DbHandles,
  commandId: string,
): Promise<TransactionCorrectionRecord | undefined> {
  const t = tables(handles);
  const row = await queryGet<{
    id: string;
    workspaceId: string;
    commandId: string;
    rootEventId: string;
    targetEventId: string;
    reversalEventId: string;
    replacementEventId: string;
    correctedOn: string;
    capturedAt: string;
    reason: string | null;
  }>(
    handles,
    anyDb(handles).select().from(t.transactionCorrections).where(eq(t.transactionCorrections.commandId, commandId)),
  );
  if (!row) return undefined;
  return {
    ...row,
    correctedOn: isoDate(row.correctedOn),
  };
}

async function loadWorkspaceCorrections(
  handles: DbHandles,
  workspaceId: string,
): Promise<TransactionCorrectionRecord[]> {
  const t = tables(handles);
  const rows = await queryAll<{
    id: string;
    workspaceId: string;
    commandId: string;
    rootEventId: string;
    targetEventId: string;
    reversalEventId: string;
    replacementEventId: string;
    correctedOn: string;
    capturedAt: string;
    reason: string | null;
  }>(
    handles,
    anyDb(handles).select().from(t.transactionCorrections).where(eq(t.transactionCorrections.workspaceId, workspaceId)),
  );
  return rows.map((row) => ({
    ...row,
    correctedOn: isoDate(row.correctedOn),
  }));
}

export async function reconstructCorrectionPayload(
  handles: DbHandles,
  correction: TransactionCorrectionRecord,
): Promise<CanonicalCorrectionPayload> {
  const replacement = await loadOwnedEvent(handles, correction.workspaceId, correction.replacementEventId);
  const postings = await loadOwnedPostings(handles, correction.workspaceId, correction.replacementEventId);
  if (replacement.meaning === "spend_account") {
    return canonicalizeCorrectionPayload({
      family: "expense",
      rootEventId: correction.rootEventId,
      targetEventId: correction.targetEventId,
      amountPaise: replacement.amountPaise,
      sourceAccountId: replacement.accountId ?? "",
      occurredOn: replacement.occurredOn,
      allocations: postings
        .filter((posting) => posting.pnl === "expense" && posting.categoryId)
        .map((posting) => ({ categoryId: posting.categoryId!, amountPaise: posting.amountPaise })),
      merchant: replacement.merchant,
      notes: replacement.notes,
      reason: correction.reason,
    });
  }
  return canonicalizeCorrectionPayload({
    family: "other_income",
    rootEventId: correction.rootEventId,
    targetEventId: correction.targetEventId,
    amountPaise: replacement.amountPaise,
    sourceAccountId: replacement.accountId ?? "",
    occurredOn: replacement.occurredOn,
    notes: replacement.notes,
    reason: correction.reason,
  });
}

/**
 * 16C1 must call this before generating reversal/replacement IDs.
 * Existing commandId → compare canonical payload and return stored event IDs.
 * New commandId → generate IDs, then persistAtomicCorrection.
 */
export async function resolveCorrectionCommandReplay(
  handles: DbHandles,
  workspaceId: string,
  commandId: string,
  material: CanonicalCorrectionPayload,
): Promise<CorrectionCommandReplay> {
  const existing = await loadCorrectionByCommandId(handles, commandId);
  if (!existing) return { status: "new" };
  if (existing.workspaceId !== workspaceId) {
    throw new DomainError("idempotency_conflict", "Command ID conflict");
  }
  const stored = await reconstructCorrectionPayload(handles, existing);
  if (!correctionPayloadsEqual(stored, material)) {
    throw new DomainError("idempotency_conflict", "Command ID conflict");
  }
  return { status: "replay", correction: existing };
}

function identityOf(
  workspaceId: string,
  input: PersistAtomicCorrectionInput,
): CorrectionCommandIdentity {
  return {
    commandId: input.commandId,
    workspaceId,
    rootEventId: input.rootEventId,
    targetEventId: input.targetEventId,
    reversalEventId: input.reversalEvent.id,
    replacementEventId: input.replacementEvent.id,
    reason: input.reason ?? null,
  };
}

async function replayExisting(
  handles: DbHandles,
  workspaceId: string,
  input: PersistAtomicCorrectionInput,
  existing: TransactionCorrectionRecord,
): Promise<PersistAtomicCorrectionResult> {
  if (existing.workspaceId !== workspaceId) {
    throw new DomainError("idempotency_conflict", "Command ID conflict");
  }
  if (input.material) {
    const stored = await reconstructCorrectionPayload(handles, existing);
    if (!correctionPayloadsEqual(stored, input.material)) {
      throw new DomainError("idempotency_conflict", "Command ID conflict");
    }
    return { correction: existing, replayed: true };
  }
  replayCorrectionOrConflict(existing, identityOf(workspaceId, input));
  return { correction: existing, replayed: true };
}

async function halt(stage: CorrectionPersistFailAfter, failAfter?: CorrectionPersistFailAfter): Promise<void> {
  if (failAfter === stage) {
    throw new Error(`correction persist test halt: ${stage}`);
  }
}

async function persistPieces(
  handles: DbHandles,
  workspaceId: string,
  input: PersistAtomicCorrectionInput,
  correction: TransactionCorrectionRecord,
): Promise<void> {
  await persistPreparedBatch(handles, workspaceId, {
    events: [input.reversalEvent],
    postings: [],
    openings: [],
  });
  await halt("reversal_event", input.failAfter);
  await persistPreparedBatch(handles, workspaceId, {
    events: [],
    postings: [...input.reversalPostings],
    openings: [],
  });
  await halt("reversal_postings", input.failAfter);
  await persistPreparedBatch(handles, workspaceId, {
    events: [input.replacementEvent],
    postings: [],
    openings: input.extra?.openings ?? [],
    ...input.extra,
  });
  await halt("replacement_event", input.failAfter);
  await persistPreparedBatch(handles, workspaceId, {
    events: [],
    postings: [...input.replacementPostings],
    openings: [],
  });
  await halt("replacement_postings", input.failAfter);
  await loadOwnedEvent(handles, workspaceId, input.reversalEvent.id);
  await loadOwnedEvent(handles, workspaceId, input.replacementEvent.id);
  await persistPreparedBatch(handles, workspaceId, {
    events: [],
    postings: [],
    openings: [],
    transactionCorrections: [correction],
  });
  await halt("correction_row", input.failAfter);
}

async function persistInsideTransaction(
  handles: DbHandles,
  workspaceId: string,
  input: PersistAtomicCorrectionInput,
): Promise<PersistAtomicCorrectionResult> {
  const existing = await loadCorrectionByCommandId(handles, input.commandId);
  if (existing) {
    return replayExisting(handles, workspaceId, input, existing);
  }

  const ownedRoot = await loadOwnedEvent(handles, workspaceId, input.rootEventId);
  const ownedTarget = await loadOwnedEvent(handles, workspaceId, input.targetEventId);
  const ownedTargetPostings = await loadOwnedPostings(handles, workspaceId, input.targetEventId);
  await assertNewEventIdAvailable(handles, workspaceId, input.reversalEvent.id);
  await assertNewEventIdAvailable(handles, workspaceId, input.replacementEvent.id);

  if (ownedTarget.occurredOn !== input.replacementEvent.occurredOn) {
    throw unknownTransaction();
  }
  if (ownedTarget.occurredOn !== input.reversalEvent.occurredOn) {
    throw unknownTransaction();
  }

  const chain = await loadWorkspaceCorrections(handles, workspaceId);
  assertNewCorrectionLink(chain, {
    rootEventId: ownedRoot.id,
    targetEventId: ownedTarget.id,
    reversalEventId: input.reversalEvent.id,
    replacementEventId: input.replacementEvent.id,
  });
  assertExactReversal(ownedTarget, ownedTargetPostings, input.reversalEvent, input.reversalPostings);
  assertConservation(input.replacementEvent.meaning, {
    events: [input.replacementEvent],
    postings: [...input.replacementPostings],
    openings: [],
  });

  const correction: TransactionCorrectionRecord = {
    id: newId(),
    workspaceId,
    commandId: input.commandId,
    rootEventId: ownedRoot.id,
    targetEventId: ownedTarget.id,
    reversalEventId: input.reversalEvent.id,
    replacementEventId: input.replacementEvent.id,
    correctedOn: isoDate(input.correctedOn),
    capturedAt: input.capturedAt,
    reason: input.reason ?? null,
  };

  try {
    await persistPieces(handles, workspaceId, input, correction);
  } catch (error) {
    if (input.failAfter) throw error;
    if (!uniqueViolation(error)) throw error;
    const raced = await loadCorrectionByCommandId(handles, input.commandId);
    if (raced) {
      return replayExisting(handles, workspaceId, input, raced);
    }
    const retryChain = await loadWorkspaceCorrections(handles, workspaceId);
    if (retryChain.some((item) => item.targetEventId === input.targetEventId)) {
      throw new DomainError("stale_correction_target", "This transaction was already corrected");
    }
    throw new DomainError("idempotency_conflict", "Command ID conflict");
  }

  return { correction, replayed: false };
}

/**
 * Persist reversal + replacement + correction row in one transaction.
 * Reloads root/target from the database; does not trust caller-owned event objects.
 * 16C1 must call `resolveCorrectionCommandReplay` with the canonical payload
 * before generating reversal/replacement IDs, then persist with `material`.
 * Replacement `occurredOn` must match the original. Internal foundation only.
 */
export async function persistAtomicCorrection(
  handles: DbHandles,
  workspaceId: string,
  input: PersistAtomicCorrectionInput,
): Promise<PersistAtomicCorrectionResult> {
  const run = (tx: DbHandles) => persistInsideTransaction(tx, workspaceId, input);
  if (handles.dialect === "sqlite") {
    return withSqliteImmediateTransaction(handles, run);
  }
  return withPostgresTransaction(handles, run);
}
