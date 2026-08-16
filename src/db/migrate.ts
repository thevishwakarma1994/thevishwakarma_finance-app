import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { count, eq } from "drizzle-orm";
import { newId } from "../domain/ids.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { schema } from "./schema.js";
import {
  closeDatabase,
  openConfiguredDatabase,
  type DbHandles,
  type SqliteHandles,
} from "./client.js";
import { describeDatabaseConfig, resolveDatabaseConfig } from "./env.js";
import { anyDb, queryGet, tables } from "./exec.js"; 
import { applyPostgresMigrations } from "./pg/migrate.js";

export function drizzleDir(): string {
  return fileURLToPath(new URL("../../drizzle", import.meta.url));
}

export function applySqliteMigrations(handles: SqliteHandles, migrationsDir = drizzleDir()): void {
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

export async function applyMigrations(handles: DbHandles): Promise<void> {
  if (handles.dialect === "sqlite") {
    applySqliteMigrations(handles);
    return;
  }
  await applyPostgresMigrations(handles);
}

export const LEGACY_WORKSPACE_NAME = "Development (legacy)";

function seedWorkspace(handles: SqliteHandles): void {
  const existing = anyDb(handles).select({ value: count() }).from(schema.workspaces).get();
  if ((existing?.value ?? 0) > 0) {
    return;
  }

  const workspaceId = newId();
  const now = utcNowIso();
  anyDb(handles).insert(schema.workspaces).values({
    id: workspaceId,
    name: LEGACY_WORKSPACE_NAME,
    createdAt: now,
  }).run();

  handles.db
    .insert(schema.categories)
    .values([
      { id: newId(), workspaceId, parentId: null, name: "Grocery", archivedAt: null },
      { id: newId(), workspaceId, parentId: null, name: "Household", archivedAt: null },
    ])
    .run();

  handles.db
    .insert(schema.accounts)
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
export async function getSoleWorkspaceId(handles: DbHandles): Promise<string> {
  const t = tables(handles);
  const legacy = await queryGet<{ id: string }>(
    handles,
    anyDb(handles).select().from(t.workspaces).where(eq(t.workspaces.name, LEGACY_WORKSPACE_NAME)),
  );
  if (legacy) return legacy.id;
  const row = await queryGet<{ id: string }>(handles, anyDb(handles).select().from(t.workspaces));
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
  const config = resolveDatabaseConfig();
  const handles = await openConfiguredDatabase(config);
  await applyMigrations(handles);
  console.log(`Migrated ${describeDatabaseConfig(config)}`);
  await closeDatabase(handles);
}
