#!/usr/bin/env node
/**
 * PostgreSQL consistent-snapshot binary backup tool (Stage 15D).
 *
 * Rules:
 * - Reads source DATABASE_URL via env or --database-url.
 * - Prints host and database name ONLY (never logs credentials).
 * - Opens a REPEATABLE READ READ ONLY transaction and exports a snapshot (pg_export_snapshot).
 * - Runs pg_dump --format=custom --snapshot=<id> to generate a custom binary archive (.dump).
 * - Computes table counts, migration checksums, and deterministic SHA-256 fingerprints in the same transaction.
 * - Saves paired manifest: backups/pg_backup_YYYYMMDD_HHMMSS.manifest.json.
 * - Never logs private financial details or user emails.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import pg from "pg";

export const EXPECTED_TABLES = [
  "workspaces",
  "users",
  "workspace_memberships",
  "accounts",
  "categories",
  "financial_events",
  "postings",
  "opening_positions",
  "credit_cards",
  "config_versions",
  "billing_cycles",
  "people",
  "claims",
  "event_shares",
  "settlement_allocations",
  "reservations",
  "reservation_ledger",
  "surplus_cases",
  "income_policies",
  "funding_cycles",
  "obligation_templates",
  "obligation_instances",
  "schema_migrations",
];

function parseArgs() {
  const args = process.argv.slice(2);
  let databaseUrl = process.env.DATABASE_URL?.trim() || "";
  let confirmProduction = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--database-url" && args[i + 1]) {
      databaseUrl = args[i + 1].trim();
      i++;
    } else if (args[i] === "--confirm-production") {
      confirmProduction = true;
    }
  }

  return { databaseUrl, confirmProduction };
}

function parseUrlSafe(connectionString) {
  try {
    const parsed = new URL(connectionString);
    return {
      host: parsed.hostname || "localhost",
      port: parsed.port || "5432",
      database: parsed.pathname.replace(/^\//, "") || "postgres",
    };
  } catch {
    throw new Error("Invalid PostgreSQL connection URL.");
  }
}

function checkPgDumpInstalled() {
  try {
    execSync("pg_dump --version", { stdio: "ignore" });
  } catch {
    throw new Error(
      "pg_dump CLI binary is not available in PATH. Please install PostgreSQL client tools.",
    );
  }
}

export function canonicalJson(obj) {
  return JSON.stringify(obj, (key, value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value;
    if (typeof value === "object" && !Array.isArray(value)) {
      const sorted = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = value[k];
      }
      return sorted;
    }
    return value;
  });
}

export async function computeTableFingerprint(client, tableName) {
  const colsRes = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );
  if (colsRes.rows.length === 0) {
    throw new Error(`Table ${tableName} does not exist in database.`);
  }

  const colNames = colsRes.rows.map((row) => row.column_name);
  const sortCol = colNames.includes("id") ? "id" : colNames.includes("filename") ? "filename" : colNames[0];

  const selectCols = colNames.map((col) => `"${col}"`).join(", ");
  const query = `SELECT ${selectCols} FROM "${tableName}" ORDER BY "${sortCol}"`;
  const rowsRes = await client.query(query);

  const hash = createHash("sha256");
  for (const row of rowsRes.rows) {
    hash.update(canonicalJson(row));
    hash.update("\n");
  }
  return {
    rowCount: rowsRes.rows.length,
    hash: hash.digest("hex"),
  };
}

async function runBackup() {
  const { databaseUrl, confirmProduction } = parseArgs();
  if (!databaseUrl) {
    console.error("DATABASE_URL is required (pass via env or --database-url)");
    process.exit(1);
  }

  checkPgDumpInstalled();
  const info = parseUrlSafe(databaseUrl);
  console.log(`[Backup] Connecting to host=${info.host} database=${info.database}`);

  const isProdHost =
    info.host.includes("render.com") ||
    info.host.includes("neon.tech") ||
    process.env.NODE_ENV === "production";

  if (isProdHost && !confirmProduction) {
    console.error(
      "ERROR: Source database appears to be Production/Staging. Pass --confirm-production to proceed.",
    );
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const backupsDir = path.resolve(process.cwd(), "backups");
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "_");
  const backupId = `pg_backup_${timestamp}`;
  const dumpFilename = `${backupId}.dump`;
  const manifestFilename = `${backupId}.manifest.json`;
  const dumpPath = path.join(backupsDir, dumpFilename);
  const manifestPath = path.join(backupsDir, manifestFilename);

  let snapshotId = null;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapRes = await client.query("SELECT pg_export_snapshot()");
    snapshotId = snapRes.rows[0].pg_export_snapshot;
    console.log(`[Backup] Exported consistent snapshot: ${snapshotId}`);

    console.log(`[Backup] Running pg_dump --format=custom --snapshot=${snapshotId}...`);
    execFileSync("pg_dump", [
      "--format=custom",
      `--snapshot=${snapshotId}`,
      `--file=${dumpPath}`,
      databaseUrl,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    if (!fs.existsSync(dumpPath) || fs.statSync(dumpPath).size === 0) {
      throw new Error("pg_dump failed to produce a valid non-zero backup file.");
    }
    const dumpSizeBytes = fs.statSync(dumpPath).size;
    const dumpFileBuffer = fs.readFileSync(dumpPath);
    const dumpChecksum = createHash("sha256").update(dumpFileBuffer).digest("hex");

    console.log(`[Backup] Computing manifest metrics in consistent snapshot...`);

    const tableListRes = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const existingTables = tableListRes.rows.map((r) => r.table_name);

    for (const expected of EXPECTED_TABLES) {
      if (!existingTables.includes(expected)) {
        throw new Error(`Expected schema table ${expected} is missing from source database.`);
      }
    }

    const migrationRes = await client.query(
      "SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename",
    );

    const tablesObj = {};
    const fingerprintsObj = {};
    for (const tableName of EXPECTED_TABLES) {
      const fp = await computeTableFingerprint(client, tableName);
      tablesObj[tableName] = fp.rowCount;
      fingerprintsObj[tableName] = fp.hash;
    }

    const manifest = {
      backupId,
      timestamp: now.toISOString(),
      sourceHost: info.host,
      sourceDatabase: info.database,
      dumpFilename,
      dumpSizeBytes,
      dumpChecksum,
      migrations: migrationRes.rows.map((row) => ({
        filename: row.filename,
        checksum: row.checksum,
        appliedAt: row.applied_at,
      })),
      tables: tablesObj,
      fingerprints: fingerprintsObj,
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await client.query("COMMIT");

    console.log(`[Backup] SUCCESS! Backup archive created: ${dumpPath}`);
    console.log(`[Backup] Manifest created: ${manifestPath}`);
    console.log(`[Backup] Summary: size=${dumpSizeBytes} bytes, checksum=${dumpChecksum.slice(0, 12)}...`);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    if (fs.existsSync(dumpPath)) {
      try {
        fs.unlinkSync(dumpPath);
      } catch {}
    }
    throw err;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("backup-pg.mjs")) {
  runBackup().catch((err) => {
    console.error(`[Backup FAILED] ${err.message}`);
    process.exit(1);
  });
}
