import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { payCard as payCardDomain } from "../domain/commands/payCard.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";

const inputSchema = z.object({
  occurredOn: z.string(),
  capturedAt: z.string(),
  creditCardId: z.string().min(1),
  billingCycleId: z.string().min(1),
  accountId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  notes: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  commit: z.boolean().default(true),
});

export async function payCard(handles: DbHandles, context: WorkspaceContext, raw: unknown) {
  const input = inputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [
    { type: "card", id: input.creditCardId },
    { type: "cycle", id: input.billingCycleId },
    { type: "account", id: input.accountId },
  ]);
  const occurredOn = isoDate(input.occurredOn);
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  const result = payCardDomain(
    {
      occurredOn,
      capturedAt: input.capturedAt,
      creditCardId: input.creditCardId,
      billingCycleId: input.billingCycleId,
      accountId: input.accountId,
      amountPaise: paise(input.amountPaise),
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
