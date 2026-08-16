import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { todayKolkata, utcNowIso } from "../domain/calendar/kolkata.js";
import { resolveSurplus as resolveSurplusDomain } from "../domain/commands/resolveSurplus.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";

const inputSchema = z.object({
  surplusCaseId: z.string().min(1),
  resolution: z.enum([
    "apply_to_other_claim",
    "convert_to_payable",
    "treat_as_mine_correction",
    "reassign_reservation",
  ]),
  amountPaise: z.number().int().positive().optional(),
  claimId: z.string().min(1).optional(),
  billingCycleId: z.string().min(1).optional(),
  confirmed: z.boolean().optional(),
  occurredOn: z.string().optional(),
  capturedAt: z.string().optional(),
  commit: z.boolean().default(true),
});

export async function resolveSurplus(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [
    { type: "surplus", id: input.surplusCaseId },
    input.claimId ? { type: "claim" as const, id: input.claimId } : null,
    input.billingCycleId ? { type: "cycle" as const, id: input.billingCycleId } : null,
  ]);
  const occurredOn = isoDate(input.occurredOn ?? todayKolkata());
  const snapshot = await loadSnapshot(handles, context.workspaceId, occurredOn);
  const result = resolveSurplusDomain(
    {
      occurredOn,
      capturedAt: input.capturedAt ?? utcNowIso(),
      surplusCaseId: input.surplusCaseId,
      resolution: input.resolution,
      amountPaise: input.amountPaise === undefined ? undefined : paise(input.amountPaise),
      claimId: input.claimId,
      billingCycleId: input.billingCycleId,
      confirmed: input.confirmed,
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
