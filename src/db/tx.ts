import type { DbHandles, PostgresHandles, SqliteHandles } from "./handles.js";

function isThenable(value: unknown): value is Promise<unknown> {
  return Boolean(value) && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Dialect transaction boundary.
 *
 * SQLite uses better-sqlite3 `transaction()` (savepoints when nested). The
 * callback must stay synchronous — no awaits — because the driver forbids
 * interleaved async I/O inside a money write.
 *
 * PostgreSQL uses a single connection from `node-postgres` via Drizzle
 * `db.transaction()`. Nested callers join the open transaction instead of
 * taking a second pool connection.
 */
export async function withTransaction<T>(
  handles: DbHandles,
  fn: (handles: DbHandles) => T | Promise<T>,
): Promise<T> {
  if (handles.dialect === "sqlite") {
    return withSqliteTransaction(handles, () => {
      const value = fn(handles);
      if (isThenable(value)) {
        throw new Error("SQLite transactions cannot contain async work");
      }
      return value as T;
    });
  }
  return withPostgresTransaction(handles, fn);
}

export function withSqliteTransaction<T>(handles: SqliteHandles, fn: () => T): T {
  return handles.sqlite.transaction(fn)();
}

export async function withPostgresTransaction<T>(
  handles: PostgresHandles,
  fn: (handles: PostgresHandles) => T | Promise<T>,
): Promise<T> {
  if (handles.inTransaction) {
    return fn(handles);
  }
  return handles.db.transaction(async (tx) => {
    const txHandles: PostgresHandles = {
      dialect: "postgres",
      pool: handles.pool,
      db: tx as PostgresHandles["db"],
      inTransaction: true,
    };
    return fn(txHandles);
  });
}
