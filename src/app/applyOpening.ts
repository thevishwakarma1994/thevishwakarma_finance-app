import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { applyOpening as applyOpeningDomain } from "../domain/commands/applyOpening.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";

const accountSchema = z.object({
  accountId: z.string().min(1),
  effectiveOn: z.string(),
  balancePaise: z.number().int(),
  commit: z.boolean().default(true),
});

const personSchema = z.object({
  personId: z.string().min(1),
  effectiveOn: z.string(),
  direction: z.enum(["they_owe_user", "user_owes_them"]),
  amountPaise: z.number().int().positive(),
  note: z.string().nullable().optional(),
  commit: z.boolean().default(true),
});

const inputSchema = z.union([accountSchema, personSchema]);

export async function applyOpening(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [
    "personId" in input ? { type: "person", id: input.personId } : { type: "account", id: input.accountId },
  ]);
  const snapshot = await loadSnapshot(handles, context.workspaceId);
  const result =
    "personId" in input
      ? applyOpeningDomain(
          {
            personId: input.personId,
            effectiveOn: isoDate(input.effectiveOn),
            direction: input.direction,
            amountPaise: paise(input.amountPaise),
            note: input.note,
          },
          snapshot,
        )
      : applyOpeningDomain(
          {
            accountId: input.accountId,
            effectiveOn: isoDate(input.effectiveOn),
            balancePaise: paise(input.balancePaise),
          },
          snapshot,
        );

  if (input.commit) {
    await persistBatch(handles, context.workspaceId, result.batch);
  }

  return {
    preview: result.preview,
    eventId: null,
    committed: input.commit,
  };
}
