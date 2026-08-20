import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { receiveSettlement as receiveSettlementDomain } from "../domain/commands/receiveSettlement.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";
import { withAccountWriteLocks } from "../db/accountWriteLock.js";

const inputSchema = z.object({
  occurredOn: z.string(),
  capturedAt: z.string(),
  accountId: z.string().min(1),
  personId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  allocations: z
    .array(
      z.object({
        claimId: z.string().min(1),
        amountPaise: z.number().int().positive(),
      }),
    )
    .min(1),
  notes: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  commit: z.boolean().default(true),
});

export async function receiveSettlement(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  const run = async (tx: DbHandles) => {
    await assertWorkspaceOwned(tx, context.workspaceId, [
      { type: "account", id: input.accountId },
      { type: "person", id: input.personId },
      ...input.allocations.map((allocation) => ({ type: "claim" as const, id: allocation.claimId })),
    ]);
    const occurredOn = isoDate(input.occurredOn);
    const snapshot = await loadSnapshot(tx, context.workspaceId, occurredOn);
    const result = receiveSettlementDomain(
      {
        occurredOn,
        capturedAt: input.capturedAt,
        accountId: input.accountId,
        personId: input.personId,
        amountPaise: paise(input.amountPaise),
        allocations: input.allocations.map((allocation) => ({
          claimId: allocation.claimId,
          amountPaise: paise(allocation.amountPaise),
        })),
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
  return withAccountWriteLocks(handles, context.workspaceId, [input.accountId], run);
}
