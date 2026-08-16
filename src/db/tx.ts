import type { SqliteHandles } from "./client.js";

export function withTransaction<T>(handles: SqliteHandles, fn: () => T): T {
  const run = handles.sqlite.transaction(fn);
  return run();
}
