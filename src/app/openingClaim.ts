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
import { DomainError } from "../domain/ledger/types.js";

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
    if (existingEvent[0].workspaceId !== context.workspaceId) {
      throw new DomainError("idempotency_conflict", "Command ID conflict");
    }
    if (existingEvent[0].meaning !== "apply_opening_claim") {
      throw new DomainError("idempotency_conflict", "commandId exists with different meaning");
    }
    const existingClaim = await anyDb(handles).select().from(t.claims).where(eq(t.claims.originatingEventId, input.commandId)).limit(1);
    const existingPersonId = existingClaim.length > 0 ? existingClaim[0].personId : null;
    const existingDirection = existingClaim.length > 0 ? existingClaim[0].direction : null;
    if (
      existingEvent[0].amountPaise !== input.amountPaise ||
      existingPersonId !== input.personId ||
      existingDirection !== input.direction
    ) {
      throw new DomainError("idempotency_conflict", "commandId exists with different payload");
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
      if (check.length > 0 && check[0].workspaceId === context.workspaceId && check[0].meaning === "apply_opening_claim") {
        const checkClaim = await anyDb(handles).select().from(t.claims).where(eq(t.claims.originatingEventId, input.commandId)).limit(1);
        const checkPersonId = checkClaim.length > 0 ? checkClaim[0].personId : null;
        const checkDirection = checkClaim.length > 0 ? checkClaim[0].direction : null;
        if (
          check[0].amountPaise === input.amountPaise &&
          checkPersonId === input.personId &&
          checkDirection === input.direction
        ) {
          return { eventId: input.commandId };
        }
      }
      throw new DomainError("idempotency_conflict", "Command ID conflict");
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
    if (existingEvent[0].workspaceId !== context.workspaceId) {
      throw new DomainError("idempotency_conflict", "Command ID conflict");
    }
    if (existingEvent[0].meaning !== "correct_opening_claim") {
      throw new DomainError("idempotency_conflict", "commandId exists with different meaning");
    }
    const existingPosting = await anyDb(handles).select().from(t.postings).where(eq(t.postings.eventId, input.commandId)).limit(1);
    const existingClaimId = existingPosting.length > 0 ? existingPosting[0].claimId : null;
    if (
      existingEvent[0].amountPaise !== input.targetAmountPaise ||
      existingClaimId !== input.claimId
    ) {
      throw new DomainError("idempotency_conflict", "commandId exists with different payload");
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
      if (check.length > 0 && check[0].workspaceId === context.workspaceId && check[0].meaning === "correct_opening_claim") {
        const checkPosting = await anyDb(handles).select().from(t.postings).where(eq(t.postings.eventId, input.commandId)).limit(1);
        const checkClaimId = checkPosting.length > 0 ? checkPosting[0].claimId : null;
        if (
          check[0].amountPaise === input.targetAmountPaise &&
          checkClaimId === input.claimId
        ) {
          return { eventId: input.commandId };
        }
      }
      throw new DomainError("idempotency_conflict", "Command ID conflict");
    }
    throw err;
  }

  return { eventId: input.commandId };
}
