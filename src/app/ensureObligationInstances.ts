import { todayKolkata } from "../domain/calendar/kolkata.js";
import type { IsoDate } from "../domain/calendar/isoDate.js";
import { persistGeneratedInstances } from "../db/generateObligations.js";
import type { SqliteHandles } from "../db/client.js";

/**
 * Explicit write: generate missing bounded obligation instances and persist them.
 * Not a read. Call before financial reads that need generated instances, or after
 * template create/change.
 */
export function materializeObligationInstances(
  handles: SqliteHandles,
  workspaceId: string,
  asOf: IsoDate = todayKolkata(),
): number {
  return persistGeneratedInstances(handles, workspaceId, asOf);
}

/** Request-orchestration alias: prepare generated instances for a working as-of. */
export function ensureObligationInstances(
  handles: SqliteHandles,
  workspaceId: string,
  asOf: IsoDate = todayKolkata(),
): number {
  return materializeObligationInstances(handles, workspaceId, asOf);
}
