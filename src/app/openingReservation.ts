import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { applyReservationOpening as applyReservationOpeningDomain, correctReservationOpening as correctReservationOpeningDomain } from "../domain/commands/openingReservation.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import { tables, anyDb, queryGet } from "../db/exec.js";
import { eq } from "drizzle-orm";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";
import { DomainError } from "../domain/ledger/types.js";
import { withOptionalCardThenAccountWriteLocks } from "../db/accountWriteLock.js";

const applyInputSchema = z.object({
  commandId: z.string().min(1),
  occurredOn: z.string(),
  capturedAt: z.string(),
  sourceAccountId: z.string().min(1),
  cardId: z.string().optional(),
  billingCycleId: z.string().optional().or(z.literal("")),
  amountPaise: z.number().int().positive(),
});

export async function applyOpeningReservation(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = applyInputSchema.parse(raw);
  const creditCardId = await creditCardIdForOpeningReservationApply(
    handles,
    context.workspaceId,
    input,
  );
  return withOptionalCardThenAccountWriteLocks(
    handles,
    context.workspaceId,
    creditCardId,
    [input.sourceAccountId],
    (tx) => runApplyOpeningReservation(tx, context, input),
  );
}

async function creditCardIdForOpeningReservationApply(
  handles: DbHandles,
  workspaceId: string,
  input: z.infer<typeof applyInputSchema>,
): Promise<string | null> {
  const billingCycleId = input.billingCycleId || undefined;
  if (billingCycleId) {
    const t = tables(handles);
    const cycle = await queryGet<{ workspaceId: string; creditCardId: string }>(
      handles,
      anyDb(handles)
        .select({
          workspaceId: t.billingCycles.workspaceId,
          creditCardId: t.billingCycles.creditCardId,
        })
        .from(t.billingCycles)
        .where(eq(t.billingCycles.id, billingCycleId)),
    );
    if (cycle && cycle.workspaceId === workspaceId) {
      return cycle.creditCardId;
    }
  }
  return input.cardId || null;
}

async function runApplyOpeningReservation(
  handles: DbHandles,
  context: WorkspaceContext,
  input: z.infer<typeof applyInputSchema>,
) {
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
    const existingRes = await anyDb(handles).select().from(t.reservations).where(eq(t.reservations.originatingEventId, input.commandId)).limit(1);
    const existingCycleId = existingRes.length > 0 ? existingRes[0].obligationRefId : null;
    if (
      existingEvent[0].amountPaise !== input.amountPaise ||
      existingEvent[0].accountId !== input.sourceAccountId ||
      (input.billingCycleId && existingCycleId !== input.billingCycleId)
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
      billingCycleId: input.billingCycleId || undefined,
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
        const checkRes = await anyDb(handles).select().from(t.reservations).where(eq(t.reservations.originatingEventId, input.commandId)).limit(1);
        const checkCycleId = checkRes.length > 0 ? checkRes[0].obligationRefId : null;
        if (
          check[0].amountPaise === input.amountPaise &&
          check[0].accountId === input.sourceAccountId &&
          (!input.billingCycleId || checkCycleId === input.billingCycleId)
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
  const plan = await lockPlanForOpeningReservationCorrect(
    handles,
    context.workspaceId,
    input.reservationId,
  );
  return withOptionalCardThenAccountWriteLocks(
    handles,
    context.workspaceId,
    plan.creditCardId,
    [plan.sourceAccountId],
    (tx) => runCorrectOpeningReservation(tx, context, input),
  );
}

async function lockPlanForOpeningReservationCorrect(
  handles: DbHandles,
  workspaceId: string,
  reservationId: string,
): Promise<{ creditCardId: string | null; sourceAccountId: string }> {
  const t = tables(handles);
  const reservation = await queryGet<{
    workspaceId: string;
    sourceAccountId: string;
    obligationRefType: string;
    obligationRefId: string;
  }>(
    handles,
    anyDb(handles)
      .select({
        workspaceId: t.reservations.workspaceId,
        sourceAccountId: t.reservations.sourceAccountId,
        obligationRefType: t.reservations.obligationRefType,
        obligationRefId: t.reservations.obligationRefId,
      })
      .from(t.reservations)
      .where(eq(t.reservations.id, reservationId)),
  );
  if (!reservation || reservation.workspaceId !== workspaceId) {
    throw new DomainError("reservation_not_found", "Reservation not found");
  }
  if (reservation.obligationRefType !== "billing_cycle") {
    return { creditCardId: null, sourceAccountId: reservation.sourceAccountId };
  }
  const cycle = await queryGet<{ workspaceId: string; creditCardId: string }>(
    handles,
    anyDb(handles)
      .select({
        workspaceId: t.billingCycles.workspaceId,
        creditCardId: t.billingCycles.creditCardId,
      })
      .from(t.billingCycles)
      .where(eq(t.billingCycles.id, reservation.obligationRefId)),
  );
  if (!cycle || cycle.workspaceId !== workspaceId) {
    throw new DomainError("cycle_not_found", "Billing cycle not found");
  }
  return { creditCardId: cycle.creditCardId, sourceAccountId: reservation.sourceAccountId };
}

async function runCorrectOpeningReservation(
  handles: DbHandles,
  context: WorkspaceContext,
  input: z.infer<typeof correctInputSchema>,
) {
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
    const existingResLedger = await anyDb(handles).select().from(t.reservationLedger).where(eq(t.reservationLedger.eventId, input.commandId)).limit(1);
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
        const checkResLedger = await anyDb(handles).select().from(t.reservationLedger).where(eq(t.reservationLedger.eventId, input.commandId)).limit(1);
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
