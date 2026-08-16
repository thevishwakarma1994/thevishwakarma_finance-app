import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { recordSplit as recordSplitDomain } from "../domain/commands/recordSplit.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import { loadCardRule } from "../db/config.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";

const inputSchema = z.object({
  occurredOn: z.string(),
  capturedAt: z.string(),
  amountPaise: z.number().int().positive(),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("account"), accountId: z.string().min(1) }),
    z.object({ type: z.literal("card"), creditCardId: z.string().min(1) }),
  ]),
  userSharePaise: z.number().int().nonnegative(),
  personShares: z
    .array(
      z.object({
        personId: z.string().min(1),
        amountPaise: z.number().int().positive(),
      }),
    )
    .min(1),
  allocations: z
    .array(
      z.object({
        categoryId: z.string().min(1),
        amountPaise: z.number().int().positive(),
      }),
    )
    .default([]),
  merchant: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  channel: z.string().nullable().optional(),
  commit: z.boolean().default(true),
});

export async function recordSplit(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [
    input.source.type === "account"
      ? { type: "account" as const, id: input.source.accountId }
      : { type: "card" as const, id: input.source.creditCardId },
    ...input.personShares.map((share) => ({ type: "person" as const, id: share.personId })),
    ...input.allocations.map((allocation) => ({ type: "category" as const, id: allocation.categoryId })),
  ]);
  const occurredOn = isoDate(input.occurredOn);
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  const source =
    input.source.type === "account"
      ? { type: "account" as const, accountId: input.source.accountId }
      : {
          type: "card" as const,
          creditCardId: input.source.creditCardId,
          rule: await loadCardRule(handles, context.workspaceId, input.source.creditCardId, occurredOn),
        };
  const result = recordSplitDomain(
    {
      occurredOn,
      capturedAt: input.capturedAt,
      amountPaise: paise(input.amountPaise),
      source,
      userSharePaise: paise(input.userSharePaise),
      personShares: input.personShares.map((share) => ({
        personId: share.personId,
        amountPaise: paise(share.amountPaise),
      })),
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
    billingCycleId: result.batch.events[0]?.billingCycleId ?? null,
    committed: input.commit,
  };
}
