import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { applyClaimOpening as applyClaimOpeningDomain, correctClaimOpening as correctClaimOpeningDomain } from "../domain/commands/openingClaim.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import { tables, anyDb } from "../db/exec.js";
import { eq } from "drizzle-orm";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";

const applyInputSchema = z.object({
  commandId: z.string().min(1),
  occurredOn: z.string(),
  capturedAt: z.string(),
  personId: z.string().min(1),
  direction: z.enum(["they_owe_user", "user_owes_them"]),
  amountPaise: z.number().int().positive(),
});

export async function applyOpeningClaim(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = applyInputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [
    { type: "person", id: input.personId },
  ]);

  const t = tables(handles);
  const existingEvent = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, input.commandId)).limit(1);
  if (existingEvent.length > 0) {
    if (existingEvent[0].meaning !== "apply_opening_claim") {
      throw new Error("idempotency_conflict");
    }
    const existingClaim = await anyDb(handles).select().from(t.claims).where(eq(t.claims.originatingEventId, input.commandId)).limit(1);
    if (
      existingEvent[0].amountPaise !== input.amountPaise ||
      !existingClaim.length ||
      existingClaim[0].personId !== input.personId ||
      existingClaim[0].direction !== input.direction
    ) {
      throw new Error("idempotency_conflict");
    }
    return { eventId: input.commandId };
  }

  const occurredOn = isoDate(input.occurredOn);
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  
  const batch = applyClaimOpeningDomain(
    {
      commandId: input.commandId,
      personId: input.personId,
      direction: input.direction,
      amountPaise: paise(input.amountPaise),
      occurredOn,
      capturedAt: input.capturedAt,
    },
    snapshot,
  );

  try {
    await persistBatch(handles, context.workspaceId, batch);
  } catch (caught) {
    const err = caught instanceof Error ? caught : undefined;
    const code = (caught as { code?: string })?.code;
    if (err?.message?.includes("UNIQUE") || code === "23505") {
      const check = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, input.commandId)).limit(1);
      if (check.length > 0 && check[0].meaning === "apply_opening_claim") {
        const existingClaim = await anyDb(handles).select().from(t.claims).where(eq(t.claims.originatingEventId, input.commandId)).limit(1);
        if (
          check[0].amountPaise === input.amountPaise &&
          existingClaim.length > 0 &&
          existingClaim[0].personId === input.personId &&
          existingClaim[0].direction === input.direction
        ) {
          return { eventId: input.commandId };
        }
      }
      throw new Error("idempotency_conflict");
    }
    throw err;
  }

  return { eventId: input.commandId };
}

const correctInputSchema = z.object({
  commandId: z.string().min(1),
  occurredOn: z.string(),
  capturedAt: z.string(),
  claimId: z.string().min(1),
  targetAmountPaise: z.number().int().min(0),
});

export async function correctOpeningClaim(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = correctInputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [
    { type: "claim", id: input.claimId },
  ]);

  const t = tables(handles);
  const existingEvent = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, input.commandId)).limit(1);
  if (existingEvent.length > 0) {
    if (existingEvent[0].meaning !== "correct_opening_claim") {
      throw new Error("idempotency_conflict");
    }
    const existingPosting = await anyDb(handles).select().from(t.postings).where(eq(t.postings.eventId, input.commandId)).limit(1);
    if (
      existingEvent[0].amountPaise !== input.targetAmountPaise ||
      !existingPosting.length ||
      existingPosting[0].claimId !== input.claimId
    ) {
      throw new Error("idempotency_conflict");
    }
    return { eventId: input.commandId };
  }

  const occurredOn = isoDate(input.occurredOn);
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  
  const batch = correctClaimOpeningDomain(
    {
      commandId: input.commandId,
      claimId: input.claimId,
      targetAmountPaise: paise(input.targetAmountPaise),
      occurredOn,
      capturedAt: input.capturedAt,
    },
    snapshot,
  );

  if (batch.events.length === 0) {
    return { eventId: null };
  }

  try {
    await persistBatch(handles, context.workspaceId, batch);
  } catch (caught) {
    const err = caught as { message?: string; code?: string };
    if (err.message?.includes("UNIQUE") || err.code === "23505") {
      const check = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, input.commandId)).limit(1);
      if (check.length > 0 && check[0].meaning === "correct_opening_claim") {
        const existingPosting = await anyDb(handles).select().from(t.postings).where(eq(t.postings.eventId, input.commandId)).limit(1);
        if (
          check[0].amountPaise === input.targetAmountPaise &&
          existingPosting.length > 0 &&
          existingPosting[0].claimId === input.claimId
        ) {
          return { eventId: input.commandId };
        }
      }
      throw new Error("idempotency_conflict");
    }
    throw err;
  }

  return { eventId: input.commandId };
}
