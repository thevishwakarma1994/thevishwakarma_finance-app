import { z } from "zod";
import { eq } from "drizzle-orm";
import { isoDate } from "../domain/calendar/isoDate.js";
import { todayKolkata } from "../domain/calendar/kolkata.js";
import { correctExpense as correctExpenseDomain } from "../domain/commands/correctExpense.js";
import {
  canonicalizeExpenseCorrectionPayload,
  newCorrectionArtifactIds,
} from "../domain/corrections/payload.js";
import { correctionCount } from "../domain/corrections/chain.js";
import { buildExpenseCorrectionPreview } from "../domain/commands/correctExpense.js";
import type { ExpenseCorrectionPreview } from "../domain/commands/correctExpense.js";
import type { TransactionCorrectionRecord } from "../domain/corrections/types.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistAtomicCorrection, resolveCorrectionCommandReplay } from "../db/persistCorrection.js";
import { withAccountWriteLocks } from "../db/accountWriteLock.js";
import { anyDb, queryGet, tables } from "../db/exec.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";

const inputSchema = z.object({
  commandId: z.string().min(1),
  rootEventId: z.string().min(1),
  targetEventId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  sourceAccountId: z.string().min(1),
  occurredOn: z.string(),
  allocations: z
    .array(
      z.object({
        categoryId: z.string().min(1),
        amountPaise: z.number().int().positive(),
      }),
    )
    .min(1),
  merchant: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  capturedAt: z.string(),
  commit: z.boolean().default(true),
});

export type ExpenseCorrectionResult = {
  preview: ExpenseCorrectionPreview;
  eventId: string | null;
  committed: boolean;
  replayed: boolean;
  rootEventId: string;
  effectiveEventId: string | null;
  correctionId: string | null;
  reversalEventId: string | null;
  replacementEventId: string | null;
  corrected: boolean;
  correctionCount: number;
};

type ParsedInput = z.infer<typeof inputSchema>;

async function lookupTargetAccountId(
  handles: DbHandles,
  workspaceId: string,
  targetEventId: string,
): Promise<string | null> {
  const t = tables(handles);
  const row = await queryGet<{ workspaceId: string; accountId: string | null }>(
    handles,
    anyDb(handles)
      .select({
        workspaceId: t.financialEvents.workspaceId,
        accountId: t.financialEvents.accountId,
      })
      .from(t.financialEvents)
      .where(eq(t.financialEvents.id, targetEventId)),
  );
  if (!row || row.workspaceId !== workspaceId) return null;
  return row.accountId;
}

function materialFrom(input: ParsedInput) {
  return canonicalizeExpenseCorrectionPayload({
    family: "expense",
    rootEventId: input.rootEventId,
    targetEventId: input.targetEventId,
    amountPaise: input.amountPaise,
    sourceAccountId: input.sourceAccountId,
    occurredOn: isoDate(input.occurredOn),
    allocations: input.allocations,
    merchant: input.merchant,
    notes: input.notes,
    reason: input.reason,
  });
}

function presentPrepared(
  prepared: ReturnType<typeof correctExpenseDomain>,
  correctionCountValue: number,
): ExpenseCorrectionResult {
  return {
    preview: prepared.preview,
    eventId: null,
    committed: false,
    replayed: false,
    rootEventId: prepared.rootEventId,
    effectiveEventId: null,
    correctionId: null,
    reversalEventId: null,
    replacementEventId: null,
    corrected: correctionCountValue > 0,
    correctionCount: correctionCountValue,
  };
}

function presentPersisted(
  snapshot: Awaited<ReturnType<typeof loadSnapshot>>,
  correction: TransactionCorrectionRecord,
  replayed: boolean,
): ExpenseCorrectionResult {
  const target = snapshot.events.find((event) => event.id === correction.targetEventId);
  const replacement = snapshot.events.find((event) => event.id === correction.replacementEventId);
  const preview =
    target && replacement
      ? buildExpenseCorrectionPreview(
          target,
          snapshot.postings.filter((posting) => posting.eventId === target.id),
          replacement,
          snapshot.postings.filter((posting) => posting.eventId === replacement.id),
          snapshot,
        )
      : {
          original: {
            amountPaise: 0,
            accountId: null,
            accountName: null,
            merchant: null,
            notes: null,
            occurredOn: correction.correctedOn,
            categories: [],
          },
          corrected: {
            amountPaise: 0,
            accountId: null,
            accountName: null,
            merchant: null,
            notes: null,
            occurredOn: correction.correctedOn,
            categories: [],
          },
          impact: [],
          effects: [],
          classifications: { spent: 0, income: 0, invested: 0, moved: 0 },
          warnings: [],
          narrative: [],
        };
  const count = correctionCount(snapshot.transactionCorrections, correction.rootEventId);
  return {
    preview,
    eventId: correction.replacementEventId,
    committed: true,
    replayed,
    rootEventId: correction.rootEventId,
    effectiveEventId: correction.replacementEventId,
    correctionId: correction.id,
    reversalEventId: correction.reversalEventId,
    replacementEventId: correction.replacementEventId,
    corrected: true,
    correctionCount: count,
  };
}

export async function correctExpenseTransaction(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
): Promise<ExpenseCorrectionResult> {
  const input = inputSchema.parse(raw);
  const material = materialFrom(input);

  if (!input.commit) {
    await assertWorkspaceOwned(handles, context.workspaceId, [
      { type: "account", id: input.sourceAccountId },
      ...input.allocations.map((allocation) => ({ type: "category" as const, id: allocation.categoryId })),
    ]);
    const snapshot = await loadSnapshot(handles, context.workspaceId);
    const prepared = correctExpenseDomain(
      {
        commandId: input.commandId,
        rootEventId: input.rootEventId,
        targetEventId: input.targetEventId,
        amountPaise: input.amountPaise,
        sourceAccountId: input.sourceAccountId,
        occurredOn: input.occurredOn,
        allocations: input.allocations,
        merchant: input.merchant,
        notes: input.notes,
        reason: input.reason,
        capturedAt: input.capturedAt,
      },
      snapshot,
    );
    return presentPrepared(prepared, correctionCount(snapshot.transactionCorrections, prepared.rootEventId));
  }

  const originalAccountId = await lookupTargetAccountId(handles, context.workspaceId, input.targetEventId);
  const lockAccountIds = originalAccountId
    ? [originalAccountId, input.sourceAccountId]
    : [input.sourceAccountId];

  return withAccountWriteLocks(handles, context.workspaceId, lockAccountIds, async (tx) => {
    await assertWorkspaceOwned(tx, context.workspaceId, [
      { type: "account", id: input.sourceAccountId },
      ...(originalAccountId && originalAccountId !== input.sourceAccountId
        ? [{ type: "account" as const, id: originalAccountId }]
        : []),
      ...input.allocations.map((allocation) => ({ type: "category" as const, id: allocation.categoryId })),
    ]);
    const snapshot = await loadSnapshot(tx, context.workspaceId);
    const replay = await resolveCorrectionCommandReplay(tx, context.workspaceId, input.commandId, material);
    if (replay.status === "replay") {
      return presentPersisted(snapshot, replay.correction, true);
    }

    const artifactIds = newCorrectionArtifactIds();
    const prepared = correctExpenseDomain(
      {
        commandId: input.commandId,
        rootEventId: input.rootEventId,
        targetEventId: input.targetEventId,
        amountPaise: input.amountPaise,
        sourceAccountId: input.sourceAccountId,
        occurredOn: input.occurredOn,
        allocations: input.allocations,
        merchant: input.merchant,
        notes: input.notes,
        reason: input.reason,
        capturedAt: input.capturedAt,
        artifactIds,
      },
      snapshot,
    );
    const persisted = await persistAtomicCorrection(tx, context.workspaceId, {
      commandId: input.commandId,
      rootEventId: prepared.rootEventId,
      targetEventId: prepared.targetEventId,
      targetEvent: prepared.targetEvent,
      targetPostings: prepared.targetPostings,
      reversalEvent: prepared.reversalEvent,
      reversalPostings: prepared.reversalPostings,
      replacementEvent: prepared.replacementEvent,
      replacementPostings: prepared.replacementPostings,
      correctedOn: todayKolkata(),
      capturedAt: input.capturedAt,
      reason: material.reason,
      material: prepared.material,
    });
    const after = await loadSnapshot(tx, context.workspaceId);
    return presentPersisted(after, persisted.correction, persisted.replayed);
  });
}
