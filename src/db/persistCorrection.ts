import { eq } from "drizzle-orm";
import { isoDate } from "../domain/calendar/isoDate.js";
import { newId } from "../domain/ids.js";
import { DomainError, type FinancialEvent, type Posting, type ProposedBatch } from "../domain/ledger/types.js";
import { assertConservation } from "../domain/conservation/validate.js";
import { assertExactReversal } from "../domain/corrections/reversal.js";
import { assertNewCorrectionLink } from "../domain/corrections/chain.js";
import { replayCorrectionOrConflict } from "../domain/corrections/idempotency.js";
import type { CorrectionCommandIdentity, TransactionCorrectionRecord } from "../domain/corrections/types.js";
import type { DbHandles } from "./handles.js";
import { anyDb, queryAll, queryGet, tables } from "./exec.js";
import { persistPreparedBatch } from "./persistBatch.js";
import { withPostgresTransaction, withSqliteImmediateTransaction } from "./tx.js";

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
  extra?: Omit<ProposedBatch, "events" | "postings" | "openings" | "transactionCorrections"> & {
    openings?: ProposedBatch["openings"];
  };
};

export type PersistAtomicCorrectionResult = {
  correction: TransactionCorrectionRecord;
  replayed: boolean;
};

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

function validatePieces(input: PersistAtomicCorrectionInput): void {
  assertExactReversal(input.targetEvent, input.targetPostings, input.reversalEvent, input.reversalPostings);
  const replacementMeaning = input.replacementEvent.meaning;
  assertConservation(replacementMeaning, {
    events: [input.replacementEvent],
    postings: [...input.replacementPostings],
    openings: [],
  });
}

async function persistPieces(
  handles: DbHandles,
  workspaceId: string,
  input: PersistAtomicCorrectionInput,
  correction: TransactionCorrectionRecord,
): Promise<void> {
  await persistPreparedBatch(handles, workspaceId, {
    events: [input.reversalEvent],
    postings: [...input.reversalPostings],
    openings: [],
  });
  await persistPreparedBatch(handles, workspaceId, {
    events: [input.replacementEvent],
    postings: [...input.replacementPostings],
    openings: input.extra?.openings ?? [],
    ...input.extra,
  });
  await persistPreparedBatch(handles, workspaceId, {
    events: [],
    postings: [],
    openings: [],
    transactionCorrections: [correction],
  });
}

async function persistInsideTransaction(
  handles: DbHandles,
  workspaceId: string,
  input: PersistAtomicCorrectionInput,
): Promise<PersistAtomicCorrectionResult> {
  const existing = await loadCorrectionByCommandId(handles, input.commandId);
  const incoming = identityOf(workspaceId, input);
  if (existing) {
    replayCorrectionOrConflict(existing, incoming);
    return { correction: existing, replayed: true };
  }

  const chain = await loadWorkspaceCorrections(handles, workspaceId);
  assertNewCorrectionLink(chain, {
    rootEventId: input.rootEventId,
    targetEventId: input.targetEventId,
    reversalEventId: input.reversalEvent.id,
    replacementEventId: input.replacementEvent.id,
  });
  validatePieces(input);

  const correction: TransactionCorrectionRecord = {
    id: newId(),
    workspaceId,
    commandId: input.commandId,
    rootEventId: input.rootEventId,
    targetEventId: input.targetEventId,
    reversalEventId: input.reversalEvent.id,
    replacementEventId: input.replacementEvent.id,
    correctedOn: isoDate(input.correctedOn),
    capturedAt: input.capturedAt,
    reason: input.reason ?? null,
  };

  try {
    await persistPieces(handles, workspaceId, input, correction);
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
    const raced = await loadCorrectionByCommandId(handles, input.commandId);
    if (raced) {
      replayCorrectionOrConflict(raced, incoming);
      return { correction: raced, replayed: true };
    }
    const targetTaken = chain.some((item) => item.targetEventId === input.targetEventId);
    const retryChain = await loadWorkspaceCorrections(handles, workspaceId);
    if (retryChain.some((item) => item.targetEventId === input.targetEventId) || targetTaken) {
      throw new DomainError("stale_correction_target", "This transaction was already corrected");
    }
    throw new DomainError("idempotency_conflict", "Command ID conflict");
  }

  return { correction, replayed: false };
}

/**
 * Persist reversal + replacement + correction row in one transaction.
 * Internal foundation only — no public correction command.
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
