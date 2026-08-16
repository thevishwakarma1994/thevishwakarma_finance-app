import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { count, eq } from "drizzle-orm";
import { newId } from "../domain/ids.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { accounts, categories, workspaces } from "./schema.js";
import { openDatabase, type SqliteHandles } from "./client.js";

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

  const files = fs
    .readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
    handles.sqlite.exec(sql);
    handles.sqlite
      .prepare("INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)")
      .run(filename, utcNowIso());
  }

  seedWorkspace(handles);
}

export const LEGACY_WORKSPACE_NAME = "Development (legacy)";

function seedWorkspace(handles: SqliteHandles): void {
  const existing = handles.db.select({ value: count() }).from(workspaces).get();
  if ((existing?.value ?? 0) > 0) {
    return;
  }

  const workspaceId = newId();
  const now = utcNowIso();
  handles.db.insert(workspaces).values({
    id: workspaceId,
    name: LEGACY_WORKSPACE_NAME,
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

/** Test/dev helper: the unowned seeded workspace, never a Firebase personal book. */
export function getSoleWorkspaceId(handles: SqliteHandles): string {
  const legacy = handles.db
    .select()
    .from(workspaces)
    .where(eq(workspaces.name, LEGACY_WORKSPACE_NAME))
    .get();
  if (legacy) return legacy.id;
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
