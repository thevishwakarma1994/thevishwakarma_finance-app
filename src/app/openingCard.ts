import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { applyCardOpening as applyCardOpeningDomain, correctCardOpening as correctCardOpeningDomain } from "../domain/commands/openingCard.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import { tables, anyDb } from "../db/exec.js";
import { eq } from "drizzle-orm";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";
import { DomainError } from "../domain/ledger/types.js";
import { withCreditCardWriteLock } from "../db/cardWriteLock.js";

const applyInputSchema = z.object({
  commandId: z.string().min(1),
  occurredOn: z.string(),
  capturedAt: z.string(),
  creditCardId: z.string().min(1),
  billingCycleId: z.string().optional().or(z.literal("")),
  amountPaise: z.number().int().min(0),
});

export async function applyOpeningCard(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = applyInputSchema.parse(raw);
  return withCreditCardWriteLock(handles, context.workspaceId, input.creditCardId, async (tx) => {
    await assertWorkspaceOwned(tx, context.workspaceId, [
      { type: "card", id: input.creditCardId },
    ]);

    const t = tables(tx);
    const existingEvent = await anyDb(tx).select().from(t.financialEvents).where(eq(t.financialEvents.id, input.commandId)).limit(1);
    if (existingEvent.length > 0) {
      if (existingEvent[0].workspaceId !== context.workspaceId) {
        throw new DomainError("idempotency_conflict", "Command ID conflict");
      }
      if (existingEvent[0].meaning !== "apply_opening_card_position") {
        throw new DomainError("idempotency_conflict", "commandId exists with different meaning");
      }
      if (
        existingEvent[0].amountPaise !== input.amountPaise ||
        existingEvent[0].creditCardId !== input.creditCardId ||
        (input.billingCycleId && existingEvent[0].billingCycleId !== input.billingCycleId)
      ) {
        throw new DomainError("idempotency_conflict", "commandId exists with different payload");
      }
      return { eventId: input.commandId };
    }

    const occurredOn = isoDate(input.occurredOn);
    const snapshot = await loadSnapshot(tx, context.workspaceId, occurredOn);

    const batch = applyCardOpeningDomain(
      {
        commandId: input.commandId,
        creditCardId: input.creditCardId,
        billingCycleId: input.billingCycleId || undefined,
        amountPaise: paise(input.amountPaise),
        occurredOn,
        capturedAt: input.capturedAt,
      },
      snapshot,
    );

    try {
      await persistBatch(tx, context.workspaceId, batch);
    } catch (caught) {
      const err = caught as { message?: string; code?: string };
      if (err.message?.includes("UNIQUE") || err.code === "23505") {
        const check = await anyDb(tx).select().from(t.financialEvents).where(eq(t.financialEvents.id, input.commandId)).limit(1);
        if (check.length > 0 && check[0].workspaceId === context.workspaceId && check[0].meaning === "apply_opening_card_position") {
          if (
            check[0].amountPaise === input.amountPaise &&
            check[0].creditCardId === input.creditCardId &&
            (!input.billingCycleId || check[0].billingCycleId === input.billingCycleId)
          ) {
            return { eventId: input.commandId };
          }
        }
        throw new DomainError("idempotency_conflict", "Command ID conflict");
      }
      throw err;
    }

    return { eventId: input.commandId };
  });
}

const correctInputSchema = z.object({
  commandId: z.string().min(1),
  occurredOn: z.string(),
  capturedAt: z.string(),
  creditCardId: z.string().min(1),
  billingCycleId: z.string().min(1),
  targetAmountPaise: z.number().int().min(0),
});

export async function correctOpeningCard(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = correctInputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [
    { type: "card", id: input.creditCardId },
    { type: "cycle", id: input.billingCycleId },
  ]);

  const t = tables(handles);
  const existingEvent = await anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.id, input.commandId)).limit(1);
  if (existingEvent.length > 0) {
    if (existingEvent[0].workspaceId !== context.workspaceId) {
      throw new DomainError("idempotency_conflict", "Command ID conflict");
    }
    if (existingEvent[0].meaning !== "correct_opening_card_position") {
      throw new DomainError("idempotency_conflict", "commandId exists with different meaning");
    }
    if (
      existingEvent[0].amountPaise !== input.targetAmountPaise ||
      existingEvent[0].creditCardId !== input.creditCardId ||
      existingEvent[0].billingCycleId !== input.billingCycleId
    ) {
      throw new DomainError("idempotency_conflict", "commandId exists with different payload");
    }
    return { eventId: input.commandId };
  }

  const occurredOn = isoDate(input.occurredOn);
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  
  const batch = correctCardOpeningDomain(
    {
      commandId: input.commandId,
      creditCardId: input.creditCardId,
      billingCycleId: input.billingCycleId,
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
      if (check.length > 0 && check[0].workspaceId === context.workspaceId && check[0].meaning === "correct_opening_card_position") {
        if (
          check[0].amountPaise === input.targetAmountPaise &&
          check[0].creditCardId === input.creditCardId &&
          check[0].billingCycleId === input.billingCycleId
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
