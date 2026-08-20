import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { transferMoney as transferMoneyDomain } from "../domain/commands/transferMoney.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";
import { withAccountWriteLocks } from "../db/accountWriteLock.js";

const inputSchema = z.object({
  occurredOn: z.string(),
  capturedAt: z.string(),
  amountPaise: z.number().int().positive(),
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  notes: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  commit: z.boolean().default(true),
});

export async function transferMoney(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  const run = async (tx: DbHandles) => {
    await assertWorkspaceOwned(tx, context.workspaceId, [
      { type: "account", id: input.fromAccountId },
      { type: "account", id: input.toAccountId },
    ]);
    const snapshot = await loadSnapshot(tx, context.workspaceId);
    const result = transferMoneyDomain(
      {
        occurredOn: isoDate(input.occurredOn),
        capturedAt: input.capturedAt,
        amountPaise: paise(input.amountPaise),
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        notes: input.notes,
        channel: input.channel,
      },
      snapshot,
    );

    if (input.commit) {
      await persistBatch(tx, context.workspaceId, result.batch);
    }

    return {
      preview: result.preview,
      eventId: result.batch.events[0]?.id ?? null,
      committed: input.commit,
    };
  };

  if (!input.commit) {
    return run(handles);
  }
  return withAccountWriteLocks(handles, context.workspaceId, [input.fromAccountId, input.toAccountId], run);
}
