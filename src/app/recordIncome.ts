import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { recordIncome as recordIncomeDomain } from "../domain/commands/recordIncome.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";

const inputSchema = z.object({
  occurredOn: z.string(),
  capturedAt: z.string(),
  amountPaise: z.number().int().positive(),
  accountId: z.string().min(1),
  kind: z.enum(["salary", "other"]),
  notes: z.string().nullable().optional(),
  commit: z.boolean().default(true),
});

export function recordIncome(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  const occurredOn = isoDate(input.occurredOn);
  const snapshot = loadSnapshot(handles, context.workspaceId, occurredOn);
  const result = recordIncomeDomain(
    {
      occurredOn: isoDate(input.occurredOn),
      capturedAt: input.capturedAt,
      amountPaise: paise(input.amountPaise),
      accountId: input.accountId,
      kind: input.kind,
      notes: input.notes,
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
