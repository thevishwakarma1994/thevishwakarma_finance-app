import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { recordCardSpend as recordCardSpendDomain } from "../domain/commands/recordCardSpend.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import { loadCardRule } from "../db/config.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";
import { withCreditCardWriteLock } from "../db/cardWriteLock.js";

const inputSchema = z.object({
  occurredOn: z.string(),
  capturedAt: z.string(),
  creditCardId: z.string().min(1),
  allocations: z
    .array(
      z.object({
        categoryId: z.string().min(1),
        amountPaise: z.number().int().positive(),
      }),
    )
    .default([]),
  amountPaise: z.number().int().positive().optional(),
  ownerPersonId: z.string().min(1).nullable().optional(),
  merchant: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  commit: z.boolean().default(true),
});

export async function recordCardSpend(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  const refs = [
    { type: "card" as const, id: input.creditCardId },
    ...input.allocations.map((allocation) => ({ type: "category" as const, id: allocation.categoryId })),
    input.ownerPersonId ? { type: "person" as const, id: input.ownerPersonId } : null,
  ];

  const run = async (tx: DbHandles) => {
    await assertWorkspaceOwned(tx, context.workspaceId, refs);
    const occurredOn = isoDate(input.occurredOn);
    const snapshot = await loadSnapshot(tx, context.workspaceId, occurredOn);
    const rule = await loadCardRule(tx, context.workspaceId, input.creditCardId, occurredOn);
    const result = recordCardSpendDomain(
      {
        occurredOn,
        capturedAt: input.capturedAt,
        creditCardId: input.creditCardId,
        allocations: input.allocations.map((allocation) => ({
          categoryId: allocation.categoryId,
          amountPaise: paise(allocation.amountPaise),
        })),
        amountPaise: input.amountPaise === undefined ? undefined : paise(input.amountPaise),
        ownerPersonId: input.ownerPersonId,
        merchant: input.merchant,
        notes: input.notes,
        channel: input.channel,
        rule,
      },
      snapshot,
    );

    if (input.commit) {
      await persistBatch(tx, context.workspaceId, result.batch);
    }

    return {
      preview: result.preview,
      eventId: result.batch.events[0]?.id ?? null,
      billingCycleId: result.batch.events[0]?.billingCycleId ?? null,
      committed: input.commit,
    };
  };

  if (!input.commit) {
    return run(handles);
  }
  return withCreditCardWriteLock(handles, context.workspaceId, input.creditCardId, run);
}
