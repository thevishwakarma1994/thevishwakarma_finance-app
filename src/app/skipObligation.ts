import { z } from "zod";
import { skipObligationInstance } from "../domain/commands/recordObligationPayment.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";

const inputSchema = z.object({
  instanceId: z.string().min(1),
});

export function skipObligation(handles: SqliteHandles, context: WorkspaceContext, raw: unknown) {
  const input = inputSchema.parse(raw);
  const snapshot = loadSnapshot(handles, context.workspaceId);
  const update = skipObligationInstance(input.instanceId, snapshot);
  persistBatch(handles, context.workspaceId, {
    events: [],
    postings: [],
    openings: [],
    obligationInstanceUpdates: [update],
  });
  return { id: update.id, status: update.status };
}
