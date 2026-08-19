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
  const scopedCommandId = `${context.workspaceId}_${input.commandId}`;
  const existingEvent = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, scopedCommandId)).limit(1);
  if (existingEvent.length > 0) {
    if (existingEvent[0].workspaceId !== context.workspaceId) {
      throw new DomainError("idempotency_conflict", "Command ID conflict");
    }
    if (existingEvent[0].meaning !== "apply_opening_reservation") {
      throw new DomainError("idempotency_conflict", "commandId exists with different meaning");
    }
    const existingRes = await anyDb(handles).select().from(t.reservations).where(eq(t.reservations.originatingEventId, input.commandId)).limit(1);
    const existingCycleId = existingRes.length > 0 ? existingRes[0].obligationRefId : null;
    if (
      existingEvent[0].amountPaise !== input.amountPaise ||
      existingEvent[0].accountId !== input.sourceAccountId ||
      existingCycleId !== input.billingCycleId
    ) {
      throw new DomainError("idempotency_conflict", "commandId exists with different payload");
    }
    return { eventId: input.commandId };
  }

  const occurredOn = isoDate(input.occurredOn);
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  
  const batch = applyReservationOpeningDomain(
    {
      commandId: scopedCommandId,
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
      const check = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, scopedCommandId)).limit(1);
      if (check.length > 0 && check[0].workspaceId === context.workspaceId && check[0].meaning === "apply_opening_reservation") {
        const checkRes = await anyDb(handles).select().from(t.reservations).where(eq(t.reservations.originatingEventId, input.commandId)).limit(1);
        const checkCycleId = checkRes.length > 0 ? checkRes[0].obligationRefId : null;
        if (
          check[0].amountPaise === input.amountPaise &&
          check[0].accountId === input.sourceAccountId &&
          checkCycleId === input.billingCycleId
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
  const scopedCommandId = `${context.workspaceId}_${input.commandId}`;
  const existingEvent = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, scopedCommandId)).limit(1);
  if (existingEvent.length > 0) {
    if (existingEvent[0].workspaceId !== context.workspaceId) {
      throw new DomainError("idempotency_conflict", "Command ID conflict");
    }
    if (existingEvent[0].meaning !== "correct_opening_reservation") {
      throw new DomainError("idempotency_conflict", "commandId exists with different meaning");
    }
    const existingResLedger = await anyDb(handles).select().from(t.reservationLedger).where(eq(t.reservationLedger.eventId, scopedCommandId)).limit(1);
    const existingReservationId = existingResLedger.length > 0 ? existingResLedger[0].reservationId : null;
    if (
      existingEvent[0].amountPaise !== input.targetAmountPaise ||
      existingReservationId !== input.reservationId
    ) {
      throw new DomainError("idempotency_conflict", "commandId exists with different payload");
    }
    return { eventId: input.commandId };
  }

  const occurredOn = isoDate(input.occurredOn);
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  
  const batch = correctReservationOpeningDomain(
    {
      commandId: scopedCommandId,
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
      const check = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, scopedCommandId)).limit(1);
      if (check.length > 0 && check[0].workspaceId === context.workspaceId && check[0].meaning === "correct_opening_reservation") {
        const checkResLedger = await anyDb(handles).select().from(t.reservationLedger).where(eq(t.reservationLedger.eventId, scopedCommandId)).limit(1);
        const checkReservationId = checkResLedger.length > 0 ? checkResLedger[0].reservationId : null;
        if (
          check[0].amountPaise === input.targetAmountPaise &&
          checkReservationId === input.reservationId
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
