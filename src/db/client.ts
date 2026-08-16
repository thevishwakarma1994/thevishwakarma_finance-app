import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { schema } from "./schema.js";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export type SqliteHandles = {
  sqlite: Database.Database;
  db: AppDatabase;
};

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
  return { sqlite, db };
}

export function openMemoryDatabase(): SqliteHandles {
  const sqlite = new Database(":memory:");
  configureSqlite(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
