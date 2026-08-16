import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { lendMoney as lendMoneyDomain } from "../domain/commands/lendMoney.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";

const inputSchema = z.object({
  occurredOn: z.string(),
  capturedAt: z.string(),
  accountId: z.string().min(1),
  personId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  notes: z.string().nullable().optional(),
  commit: z.boolean().default(true),
});

export function lendMoney(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  assertWorkspaceOwned(handles, context.workspaceId, [
    { type: "account", id: input.accountId },
    { type: "person", id: input.personId },
  ]);
  const occurredOn = isoDate(input.occurredOn);
  const snapshot = loadSnapshot(handles, context.workspaceId, occurredOn);
  const result = lendMoneyDomain(
    {
      occurredOn,
      capturedAt: input.capturedAt,
      accountId: input.accountId,
      personId: input.personId,
      amountPaise: paise(input.amountPaise),
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
