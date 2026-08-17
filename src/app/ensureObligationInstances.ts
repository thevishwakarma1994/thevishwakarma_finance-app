import { todayKolkata } from "../domain/calendar/kolkata.js";
import type { IsoDate } from "../domain/calendar/isoDate.js";
import { persistGeneratedInstances } from "../db/generateObligations.js";
import type { DbHandles } from "../db/client.js";
import { addDbQueries, timedPerf } from "../perf/timing.js";

/**
 * Explicit write: generate missing bounded obligation instances and persist them.
 * Not a read. Call before financial reads that need generated instances, or after
 * template create/change.
 */
export async function materializeObligationInstances(
  handles: DbHandles,
  workspaceId: string,
  asOf: IsoDate = todayKolkata(),
): Promise<number> {
  return timedPerf("obligationsMs", async () => {
    // templates + instances + config_versions reads inside persistGeneratedInstances
    addDbQueries(3);
    return persistGeneratedInstances(handles, workspaceId, asOf);
  });
}

/** Request-orchestration alias: prepare generated instances for a working as-of. */
export async function ensureObligationInstances(
  handles: DbHandles,
  workspaceId: string,
  asOf: IsoDate = todayKolkata(),
): Promise<number> {
  return materializeObligationInstances(handles, workspaceId, asOf);
}
