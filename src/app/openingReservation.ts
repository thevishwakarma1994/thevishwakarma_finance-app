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

const applyInputSchema = z.object({
  commandId: z.string().min(1),
  occurredOn: z.string(),
  capturedAt: z.string(),
  sourceAccountId: z.string().min(1),
  billingCycleId: z.string().min(1),
  amountPaise: z.number().int().positive(),
});

export async function applyOpeningReservation(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = applyInputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [
    { type: "account", id: input.sourceAccountId },
    { type: "cycle", id: input.billingCycleId },
  ]);

  const t = tables(handles);
  const existingEvent = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, input.commandId)).limit(1);
  if (existingEvent.length > 0) {
    if (existingEvent[0].meaning !== "apply_opening_reservation") {
      throw new Error("idempotency_conflict");
    }
    const existingRes = await anyDb(handles).select().from(t.reservations).where(eq(t.reservations.originatingEventId, input.commandId)).limit(1);
    if (
      existingEvent[0].amountPaise !== input.amountPaise ||
      existingEvent[0].accountId !== input.sourceAccountId ||
      !existingRes.length ||
      existingRes[0].obligationRefId !== input.billingCycleId
    ) {
      throw new Error("idempotency_conflict");
    }
    return { eventId: input.commandId };
  }

  const occurredOn = isoDate(input.occurredOn);
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  
  const batch = applyReservationOpeningDomain(
    {
      commandId: input.commandId,
      sourceAccountId: input.sourceAccountId,
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
      if (check.length > 0 && check[0].meaning === "apply_opening_reservation") {
        const existingRes = await anyDb(handles).select().from(t.reservations).where(eq(t.reservations.originatingEventId, input.commandId)).limit(1);
        if (
          check[0].amountPaise === input.amountPaise &&
          check[0].accountId === input.sourceAccountId &&
          existingRes.length > 0 &&
          existingRes[0].obligationRefId === input.billingCycleId
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
    if (existingEvent[0].meaning !== "correct_opening_reservation") {
      throw new Error("idempotency_conflict");
    }
    const existingLedger = await anyDb(handles).select().from(t.reservationLedger).where(eq(t.reservationLedger.eventId, input.commandId)).limit(1);
    if (
      existingEvent[0].amountPaise !== input.targetAmountPaise ||
      !existingLedger.length ||
      existingLedger[0].reservationId !== input.reservationId
    ) {
      throw new Error("idempotency_conflict");
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
      if (check.length > 0 && check[0].meaning === "correct_opening_reservation") {
        const existingLedger = await anyDb(handles).select().from(t.reservationLedger).where(eq(t.reservationLedger.eventId, input.commandId)).limit(1);
        if (
          check[0].amountPaise === input.targetAmountPaise &&
          existingLedger.length > 0 &&
          existingLedger[0].reservationId === input.reservationId
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
