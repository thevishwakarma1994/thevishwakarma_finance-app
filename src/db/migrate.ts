import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { count } from "drizzle-orm";
import { newId } from "../domain/ids.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { accounts, categories, workspaces } from "./schema.js";
import { openDatabase, type SqliteHandles } from "./client.js";

const MIGRATION_FILE = "0000_init.sql";

export function drizzleDir(): string {
  return fileURLToPath(new URL("../../drizzle", import.meta.url));
}

export function applyMigrations(handles: SqliteHandles, migrationsDir = drizzleDir()): void {
  handles.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    handles.sqlite
      .prepare("SELECT filename FROM schema_migrations")
      .all()
      .map((row) => (row as { filename: string }).filename),
  );

  const sqlPath = path.join(migrationsDir, MIGRATION_FILE);
  if (!applied.has(MIGRATION_FILE)) {
    const sql = fs.readFileSync(sqlPath, "utf8");
    handles.sqlite.exec(sql);
    handles.sqlite
      .prepare("INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)")
      .run(MIGRATION_FILE, utcNowIso());
  }

  seedWorkspace(handles);
}

function seedWorkspace(handles: SqliteHandles): void {
  const existing = handles.db.select({ value: count() }).from(workspaces).get();
  if ((existing?.value ?? 0) > 0) {
    return;
  }

  const workspaceId = newId();
  const now = utcNowIso();
  handles.db.insert(workspaces).values({
    id: workspaceId,
    name: "Personal",
    createdAt: now,
  }).run();

  handles.db
    .insert(categories)
    .values([
      { id: newId(), workspaceId, parentId: null, name: "Grocery", archivedAt: null },
      { id: newId(), workspaceId, parentId: null, name: "Household", archivedAt: null },
    ])
    .run();

  handles.db
    .insert(accounts)
    .values({
      id: newId(),
      workspaceId,
      kind: "bank",
      displayName: "HDFC",
      mask: "2581",
      isPrimarySalary: 1,
      status: "active",
      createdAt: now,
    })
    .run();
}

export function getSoleWorkspaceId(handles: SqliteHandles): string {
  const row = handles.db.select().from(workspaces).get();
  if (!row) {
    throw new Error("Workspace has not been seeded");
  }
  return row.id;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  const databasePath = process.env.DATABASE_PATH ?? "data/app.sqlite";
  const handles = openDatabase(databasePath);
  applyMigrations(handles);
  console.log(`Migrated ${databasePath}`);
}
