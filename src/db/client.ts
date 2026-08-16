import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "./schema.js";
import { openPostgresDatabase } from "./pg/client.js";
import type { DatabaseConfig } from "./env.js";
import type { DbHandles, SqliteHandles } from "./handles.js";

export type { DbHandles, PostgresHandles, SqliteHandles } from "./handles.js";
export { isPostgres, isSqlite } from "./handles.js";

function configureSqlite(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
}

export function openDatabase(databasePath: string): SqliteHandles {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const sqlite = new Database(databasePath);
  configureSqlite(sqlite);
  try {
    fs.chmodSync(databasePath, 0o600);
  } catch {
    // Ignore on filesystems that do not support POSIX modes.
  }
  const db = drizzle(sqlite, { schema });
  return { dialect: "sqlite", sqlite, db };
}

export function openMemoryDatabase(): SqliteHandles {
  const sqlite = new Database(":memory:");
  configureSqlite(sqlite);
  const db = drizzle(sqlite, { schema });
  return { dialect: "sqlite", sqlite, db };
}

export async function openConfiguredDatabase(config: DatabaseConfig): Promise<DbHandles> {
  if (config.backend === "sqlite") {
    return openDatabase(config.sqlitePath);
  }
  return openPostgresDatabase(config.connectionString);
}

export async function closeDatabase(handles: DbHandles): Promise<void> {
  if (handles.dialect === "sqlite") {
    handles.sqlite.close();
    return;
  }
  await handles.pool.end();
}
