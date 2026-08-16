import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { utcNowIso } from "../../domain/calendar/kolkata.js";
import type { PostgresHandles } from "../handles.js";

export function postgresMigrationsDir(): string {
  return fileURLToPath(new URL("../../../drizzle-pg", import.meta.url));
}

export function listPostgresMigrationFiles(migrationsDir = postgresMigrationsDir()): string[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`PostgreSQL migrations directory is missing: ${migrationsDir}`);
  }
  return fs
    .readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
}

export function postgresMigrationChecksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function ensureMigrationsTable(handles: PostgresHandles): Promise<void> {
  await handles.pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  await handles.pool.query(`
    ALTER TABLE schema_migrations
      ADD COLUMN IF NOT EXISTS checksum TEXT NOT NULL DEFAULT '';
  `);
}

async function loadApplied(
  handles: PostgresHandles,
): Promise<Map<string, { checksum: string }>> {
  const result = await handles.pool.query<{ filename: string; checksum: string }>(
    "SELECT filename, checksum FROM schema_migrations",
  );
  return new Map(result.rows.map((row) => [row.filename, { checksum: row.checksum ?? "" }]));
}

export async function assertPostgresMigrationsApplied(
  handles: PostgresHandles,
  migrationsDir = postgresMigrationsDir(),
): Promise<void> {
  const files = listPostgresMigrationFiles(migrationsDir);
  if (files.length === 0) {
    throw new Error("PostgreSQL schema is missing migration files");
  }
  const applied = await loadApplied(handles);
  for (const filename of files) {
    const row = applied.get(filename);
    if (!row) {
      throw new Error(`PostgreSQL schema is missing migration ${filename}`);
    }
    const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
    const checksum = postgresMigrationChecksum(sql);
    if (row.checksum && row.checksum !== checksum) {
      throw new Error(`PostgreSQL migration ${filename} checksum mismatch`);
    }
  }
}

export async function applyPostgresMigrations(
  handles: PostgresHandles,
  migrationsDir = postgresMigrationsDir(),
): Promise<void> {
  await ensureMigrationsTable(handles);

  const files = listPostgresMigrationFiles(migrationsDir);
  if (files.length === 0) {
    throw new Error("PostgreSQL schema is missing migration files");
  }

  const applied = await loadApplied(handles);

  for (const filename of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
    const checksum = postgresMigrationChecksum(sql);
    const existing = applied.get(filename);
    if (existing) {
      if (!existing.checksum) {
        await handles.pool.query("UPDATE schema_migrations SET checksum = $1 WHERE filename = $2", [
          checksum,
          filename,
        ]);
        existing.checksum = checksum;
        continue;
      }
      if (existing.checksum !== checksum) {
        throw new Error(`PostgreSQL migration ${filename} checksum mismatch`);
      }
      continue;
    }

    const client = await handles.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum, applied_at) VALUES ($1, $2, $3)",
        [filename, checksum, utcNowIso()],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  await assertPostgresMigrationsApplied(handles, migrationsDir);
}

const DATA_TABLES = [
  "obligation_instances",
  "obligation_templates",
  "funding_cycles",
  "income_policies",
  "surplus_cases",
  "reservation_ledger",
  "reservations",
  "settlement_allocations",
  "event_shares",
  "claims",
  "postings",
  "financial_events",
  "opening_positions",
  "billing_cycles",
  "config_versions",
  "credit_cards",
  "categories",
  "accounts",
  "workspace_memberships",
  "users",
  "workspaces",
] as const;

/** Test helper: empty financial/auth tables while keeping schema_migrations. */
export async function truncatePostgresData(handles: PostgresHandles): Promise<void> {
  await handles.pool.query(`TRUNCATE TABLE ${DATA_TABLES.join(", ")} CASCADE`);
}
