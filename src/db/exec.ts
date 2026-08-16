/* Dialect-union Drizzle clients/tables are not callable together; isolate that here. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { schema as sqliteSchema } from "./schema.js";
import { schema as pgSchema } from "./pg/schema.js";
import type { DbHandles, SqliteHandles } from "./handles.js";

export function tables(handles: DbHandles): any {
  return handles.dialect === "sqlite" ? sqliteSchema : pgSchema;
}

/** Dialect-union Drizzle clients are not callable together; keep that inside src/db. */
export function anyDb(handles: DbHandles): AnyDrizzle {
  return handles.db as unknown as AnyDrizzle;
}

export type AnyDrizzle = {
  select: (...args: any[]) => any;
  insert: (table: any) => any;
  update: (table: any) => any;
  delete: (table: any) => any;
};

export function anyTables(handles: DbHandles): any {
  return tables(handles);
}

type SqliteQuery<T> = {
  all: () => T[];
  get: () => T | undefined;
  run: () => unknown;
};

export async function queryAll<T = any>(handles: DbHandles, qb: SqliteQuery<T> | Promise<T[]>): Promise<T[]> {
  if (handles.dialect === "sqlite") {
    return (qb as SqliteQuery<T>).all();
  }
  return qb as Promise<T[]>;
}

export async function queryGet<T = any>(
  handles: DbHandles,
  qb: SqliteQuery<T> | Promise<T[]>,
): Promise<T | undefined> {
  if (handles.dialect === "sqlite") {
    return (qb as SqliteQuery<T>).get();
  }
  const rows = await (qb as Promise<T[]>);
  return rows[0];
}

export async function queryRun(handles: DbHandles, qb: { run: () => unknown } | Promise<unknown>): Promise<void> {
  if (handles.dialect === "sqlite") {
    (qb as { run: () => unknown }).run();
    return;
  }
  await qb;
}

/** SQLite-only. Must not be used inside an async callback passed to better-sqlite3 transactions. */
export function queryRunSync(handles: SqliteHandles, qb: { run: () => unknown }): void {
  qb.run();
}

export function queryAllSync<T>(handles: SqliteHandles, qb: { all: () => T[] }): T[] {
  return qb.all();
}

export function queryGetSync<T>(handles: SqliteHandles, qb: { get: () => T | undefined }): T | undefined {
  return qb.get();
}
