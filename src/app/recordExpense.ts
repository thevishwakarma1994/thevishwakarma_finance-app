import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { recordExpense as recordExpenseDomain } from "../domain/commands/recordExpense.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";

const inputSchema = z.object({
  occurredOn: z.string(),
  capturedAt: z.string(),
  accountId: z.string().min(1),
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
  channel: z.string().nullable().optional(),
  commit: z.boolean().default(true),
});

export async function recordExpense(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [
    { type: "account", id: input.accountId },
    ...input.allocations.map((allocation) => ({ type: "category" as const, id: allocation.categoryId })),
  ]);
  const snapshot = await loadSnapshot(handles, context.workspaceId);
  const result = recordExpenseDomain(
    {
      occurredOn: isoDate(input.occurredOn),
      capturedAt: input.capturedAt,
      accountId: input.accountId,
      allocations: input.allocations.map((allocation) => ({
        categoryId: allocation.categoryId,
        amountPaise: paise(allocation.amountPaise),
      })),
      merchant: input.merchant,
      notes: input.notes,
      channel: input.channel,
    },
    snapshot,
  );

  if (input.commit) {
    await persistBatch(handles, context.workspaceId, result.batch);
  }

  return {
    preview: result.preview,
    eventId: result.batch.events[0]?.id ?? null,
    committed: input.commit,
  };
}
