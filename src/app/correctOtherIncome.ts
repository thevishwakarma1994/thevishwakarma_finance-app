import { z } from "zod";
import { eq } from "drizzle-orm";
import { isoDate } from "../domain/calendar/isoDate.js";
import { todayKolkata } from "../domain/calendar/kolkata.js";
import {
  buildOtherIncomeCorrectionPreview,
  correctOtherIncome as correctOtherIncomeDomain,
  type OtherIncomeCorrectionPreview,
} from "../domain/commands/correctOtherIncome.js";
import {
  canonicalizeOtherIncomeCorrectionPayload,
  newCorrectionArtifactIds,
} from "../domain/corrections/payload.js";
import { correctionCount } from "../domain/corrections/chain.js";
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
  destinationAccountId: z.string().min(1),
  occurredOn: z.string(),
  notes: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  capturedAt: z.string(),
  commit: z.boolean().default(true),
});

export type OtherIncomeCorrectionResult = {
  preview: OtherIncomeCorrectionPreview;
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
  return canonicalizeOtherIncomeCorrectionPayload({
    family: "other_income",
    rootEventId: input.rootEventId,
    targetEventId: input.targetEventId,
    amountPaise: input.amountPaise,
    sourceAccountId: input.destinationAccountId,
    occurredOn: isoDate(input.occurredOn),
    notes: input.notes,
    reason: input.reason,
  });
}

function domainInput(
  input: ParsedInput,
  artifactIds?: { reversalEventId: string; replacementEventId: string },
) {
  return {
    commandId: input.commandId,
    rootEventId: input.rootEventId,
    targetEventId: input.targetEventId,
    amountPaise: input.amountPaise,
    destinationAccountId: input.destinationAccountId,
    occurredOn: input.occurredOn,
    notes: input.notes,
    reason: input.reason,
    capturedAt: input.capturedAt,
    artifactIds,
  };
}

function presentPrepared(
  prepared: ReturnType<typeof correctOtherIncomeDomain>,
  correctionCountValue: number,
): OtherIncomeCorrectionResult {
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
): OtherIncomeCorrectionResult {
  const target = snapshot.events.find((event) => event.id === correction.targetEventId);
  const replacement = snapshot.events.find((event) => event.id === correction.replacementEventId);
  const preview =
    target && replacement
      ? buildOtherIncomeCorrectionPreview(
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

export async function correctOtherIncomeTransaction(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
): Promise<OtherIncomeCorrectionResult> {
  const input = inputSchema.parse(raw);
  const material = materialFrom(input);

  if (!input.commit) {
    await assertWorkspaceOwned(handles, context.workspaceId, [
      { type: "account", id: input.destinationAccountId },
    ]);
    const snapshot = await loadSnapshot(handles, context.workspaceId);
    const prepared = correctOtherIncomeDomain(domainInput(input), snapshot);
    return presentPrepared(prepared, correctionCount(snapshot.transactionCorrections, prepared.rootEventId));
  }

  const originalAccountId = await lookupTargetAccountId(handles, context.workspaceId, input.targetEventId);
  const lockAccountIds = originalAccountId
    ? [originalAccountId, input.destinationAccountId]
    : [input.destinationAccountId];

  return withAccountWriteLocks(handles, context.workspaceId, lockAccountIds, async (tx) => {
    await assertWorkspaceOwned(tx, context.workspaceId, [
      { type: "account", id: input.destinationAccountId },
      ...(originalAccountId && originalAccountId !== input.destinationAccountId
        ? [{ type: "account" as const, id: originalAccountId }]
        : []),
    ]);
    const snapshot = await loadSnapshot(tx, context.workspaceId);
    const replay = await resolveCorrectionCommandReplay(tx, context.workspaceId, input.commandId, material);
    if (replay.status === "replay") {
      return presentPersisted(snapshot, replay.correction, true);
    }

    const artifactIds = newCorrectionArtifactIds();
    const prepared = correctOtherIncomeDomain(domainInput(input, artifactIds), snapshot);
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
