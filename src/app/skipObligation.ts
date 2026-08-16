import { z } from "zod";
import { skipObligationInstance } from "../domain/commands/recordObligationPayment.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";

const inputSchema = z.object({
  instanceId: z.string().min(1),
});

export async function skipObligation(handles: DbHandles, context: WorkspaceContext, raw: unknown) {
  const input = inputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [{ type: "obligation", id: input.instanceId }]);
  const snapshot = await loadSnapshot(handles, context.workspaceId);
  const update = skipObligationInstance(input.instanceId, snapshot);
  await persistBatch(handles, context.workspaceId, {
    events: [],
    postings: [],
    openings: [],
    obligationInstanceUpdates: [update],
  });
  return { id: update.id, status: update.status };
}
