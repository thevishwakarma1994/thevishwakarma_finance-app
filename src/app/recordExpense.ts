import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { recordExpense as recordExpenseDomain } from "../domain/commands/recordExpense.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";

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

export function recordExpense(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  const snapshot = loadSnapshot(handles, context.workspaceId);
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
    persistBatch(handles, context.workspaceId, result.batch);
  }

  return {
    preview: result.preview,
    eventId: result.batch.events[0]?.id ?? null,
    committed: input.commit,
  };
}
