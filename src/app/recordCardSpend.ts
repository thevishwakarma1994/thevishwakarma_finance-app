import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { recordCardSpend as recordCardSpendDomain } from "../domain/commands/recordCardSpend.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import { loadCardRule } from "../db/config.js";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";

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
    .min(1),
  merchant: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  commit: z.boolean().default(true),
});

export function recordCardSpend(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  const occurredOn = isoDate(input.occurredOn);
  const snapshot = loadSnapshot(handles, context.workspaceId, occurredOn);
  const rule = loadCardRule(handles, context.workspaceId, input.creditCardId, occurredOn);
  const result = recordCardSpendDomain(
    {
      occurredOn,
      capturedAt: input.capturedAt,
      creditCardId: input.creditCardId,
      allocations: input.allocations.map((allocation) => ({
        categoryId: allocation.categoryId,
        amountPaise: paise(allocation.amountPaise),
      })),
      merchant: input.merchant,
      notes: input.notes,
      channel: input.channel,
      rule,
    },
    snapshot,
  );

  if (input.commit) {
    persistBatch(handles, context.workspaceId, result.batch);
  }

  return {
    preview: result.preview,
    eventId: result.batch.events[0]?.id ?? null,
    billingCycleId: result.batch.events[0]?.billingCycleId ?? null,
    committed: input.commit,
  };
}
