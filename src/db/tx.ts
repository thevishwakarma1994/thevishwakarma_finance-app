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
  if (handles.inTransaction) {
    return fn();
  }
  return handles.sqlite.transaction(() => {
    const previous = handles.inTransaction;
    handles.inTransaction = true;
    try {
      return fn();
    } finally {
      handles.inTransaction = previous;
    }
  })();
}

/**
 * Serialize async SQLite read→validate→write on one connection, and take a
 * database write lock (`BEGIN IMMEDIATE`) so a second connection cannot commit
 * card lifecycle between our snapshot and persist.
 *
 * better-sqlite3 forbids awaiting inside `Database#transaction()`. This wrapper
 * is the async equivalent: a per-connection JS gate plus IMMEDIATE, so other
 * code cannot use the same connection between BEGIN and COMMIT.
 */
const sqliteWriteGates = new WeakMap<object, Promise<void>>();

function runSqliteExclusive<T>(connection: object, fn: () => Promise<T>): Promise<T> {
  const previous = sqliteWriteGates.get(connection) ?? Promise.resolve();
  let release: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  sqliteWriteGates.set(
    connection,
    previous.then(() => done).catch(() => done),
  );
  return previous.then(fn).finally(release);
}

export async function withSqliteImmediateTransaction<T>(
  handles: SqliteHandles,
  fn: (handles: SqliteHandles) => T | Promise<T>,
): Promise<T> {
  if (handles.inTransaction) {
    return fn(handles);
  }
  return runSqliteExclusive(handles.sqlite, async () => {
    await beginImmediateAsync(handles.sqlite);
    const txHandles: SqliteHandles = { ...handles, inTransaction: true };
    try {
      const result = await fn(txHandles);
      handles.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        handles.sqlite.exec("ROLLBACK");
      } catch {
        // Connection already rolled back or closed.
      }
      throw error;
    }
  });
}

function isSqliteBusy(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: string }).code === "SQLITE_BUSY",
  );
}

/**
 * `BEGIN IMMEDIATE` is synchronous in better-sqlite3. A second connection that
 * busy-waits would freeze the event loop and prevent the lock holder from
 * committing. Fail immediately and retry after a tick instead.
 */
async function beginImmediateAsync(sqlite: SqliteHandles["sqlite"]): Promise<void> {
  sqlite.pragma("busy_timeout = 0");
  const deadline = Date.now() + 10_000;
  try {
    for (;;) {
      try {
        sqlite.exec("BEGIN IMMEDIATE");
        return;
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  } finally {
    sqlite.pragma("busy_timeout = 5000");
  }
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
