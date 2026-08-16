import type { Pool } from "pg";
import type Database from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { schema as sqliteSchema } from "./schema.js";
import type { schema as pgSchema } from "./pg/schema.js";

export type SqliteDatabase = BetterSQLite3Database<typeof sqliteSchema>;
export type PostgresDatabase = NodePgDatabase<typeof pgSchema>;

export type SqliteHandles = {
  dialect: "sqlite";
  sqlite: Database.Database;
  db: SqliteDatabase;
};

export type PostgresHandles = {
  dialect: "postgres";
  pool: Pool;
  db: PostgresDatabase;
  inTransaction?: boolean;
};

export type DbHandles = SqliteHandles | PostgresHandles;

export function isSqlite(handles: DbHandles): handles is SqliteHandles {
  return handles.dialect === "sqlite";
}

export function isPostgres(handles: DbHandles): handles is PostgresHandles {
  return handles.dialect === "postgres";
}
