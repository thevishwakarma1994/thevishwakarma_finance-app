import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { applyOpening as applyOpeningDomain } from "../domain/commands/applyOpening.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";

const inputSchema = z.object({
  accountId: z.string().min(1),
  effectiveOn: z.string(),
  balancePaise: z.number().int(),
  commit: z.boolean().default(true),
});

export function applyOpening(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  const snapshot = loadSnapshot(handles, context.workspaceId);
  const result = applyOpeningDomain(
    {
      accountId: input.accountId,
      effectiveOn: isoDate(input.effectiveOn),
      balancePaise: paise(input.balancePaise),
    },
    snapshot,
  );

  if (input.commit) {
    persistBatch(handles, context.workspaceId, result.batch);
  }

  return {
    preview: result.preview,
    eventId: null,
    committed: input.commit,
  };
}
