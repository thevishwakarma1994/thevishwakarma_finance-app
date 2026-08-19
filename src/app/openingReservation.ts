import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { applyReservationOpening as applyReservationOpeningDomain, correctReservationOpening as correctReservationOpeningDomain } from "../domain/commands/openingReservation.js";
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
  sourceAccountId: z.string().min(1),
  cardId: z.string().optional(),
  billingCycleId: z.string().min(1),
  amountPaise: z.number().int().positive(),
});

export async function applyOpeningReservation(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = applyInputSchema.parse(raw);
  const checks: { type: "account" | "cycle" | "card"; id: string }[] = [
    { type: "account", id: input.sourceAccountId },
  ];
  if (input.cardId) {
    checks.push({ type: "card", id: input.cardId });
  }
  await assertWorkspaceOwned(handles, context.workspaceId, checks);

  const t = tables(handles);
  const existingEvent = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, input.commandId)).limit(1);
  if (existingEvent.length > 0) {
    if (existingEvent[0].workspaceId !== context.workspaceId) {
      throw new DomainError("idempotency_conflict", "Command ID conflict");
    }
    if (existingEvent[0].meaning !== "apply_opening_reservation") {
      throw new DomainError("idempotency_conflict", "commandId exists with different meaning");
    }
    if (
      existingEvent[0].amountPaise !== input.amountPaise ||
      existingEvent[0].accountId !== input.sourceAccountId
    ) {
      throw new DomainError("idempotency_conflict", "commandId exists with different payload");
    }
    return { eventId: input.commandId };
  }

  const occurredOn = isoDate(input.occurredOn);
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  
  const batch = applyReservationOpeningDomain(
    {
      commandId: input.commandId,
      sourceAccountId: input.sourceAccountId,
      cardId: input.cardId ?? "",
      billingCycleId: input.billingCycleId,
      amountPaise: paise(input.amountPaise),
      occurredOn,
      capturedAt: input.capturedAt,
    },
    snapshot,
  );

  try {
    await persistBatch(handles, context.workspaceId, batch);
  } catch (caught) {
    const err = caught as { message?: string; code?: string };
    if (err.message?.includes("UNIQUE") || err.code === "23505") {
      const check = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, input.commandId)).limit(1);
      if (check.length > 0 && check[0].workspaceId === context.workspaceId && check[0].meaning === "apply_opening_reservation") {
        if (
          check[0].amountPaise === input.amountPaise &&
          check[0].accountId === input.sourceAccountId
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
  reservationId: z.string().min(1),
  targetAmountPaise: z.number().int().min(0),
});

export async function correctOpeningReservation(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = correctInputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [
    { type: "reservation", id: input.reservationId },
  ]);
  
  const t = tables(handles);
  const existingEvent = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, input.commandId)).limit(1);
  if (existingEvent.length > 0) {
    if (existingEvent[0].workspaceId !== context.workspaceId) {
      throw new DomainError("idempotency_conflict", "Command ID conflict");
    }
    if (existingEvent[0].meaning !== "correct_opening_reservation") {
      throw new DomainError("idempotency_conflict", "commandId exists with different meaning");
    }
    if (
      existingEvent[0].amountPaise !== input.targetAmountPaise
    ) {
      throw new DomainError("idempotency_conflict", "commandId exists with different payload");
    }
    return { eventId: input.commandId };
  }

  const occurredOn = isoDate(input.occurredOn);
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  
  const batch = correctReservationOpeningDomain(
    {
      commandId: input.commandId,
      reservationId: input.reservationId,
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
      if (check.length > 0 && check[0].workspaceId === context.workspaceId && check[0].meaning === "correct_opening_reservation") {
        if (
          check[0].amountPaise === input.targetAmountPaise
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
