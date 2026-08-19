#!/usr/bin/env node
/**
 * PostgreSQL read-only backup integrity verification tool (Stage 15D).
 *
 * Rules:
 * - Accepts target DATABASE_URL (--target-url) and manifest file (--manifest).
 * - Reads manifest file and verifies SHA-256 checksum of associated .dump file.
 * - Inspects target PostgreSQL database in 100% READ-ONLY mode.
 * - Verifies schema_migrations records and checksums.
 * - Verifies existence of all 23 expected schema tables.
 * - Computes table row counts and deterministic SHA-256 fingerprints.
 * - Compares target manifest against source manifest 1:1.
 * - Never logs private financial details or user credentials.
 * - Exits 0 if manifests match 100%, non-zero on any mismatch.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import pg from "pg";
import { EXPECTED_TABLES, computeTableFingerprint } from "./backup-pg.mjs";

function parseArgs() {
  const args = process.argv.slice(2);
  let targetUrl = "";
  let manifestPath = "";
  let dumpPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target-url" && args[i + 1]) {
      targetUrl = args[i + 1].trim();
      i++;
    } else if (args[i] === "--manifest" && args[i + 1]) {
      manifestPath = args[i + 1].trim();
      i++;
    } else if (args[i] === "--dump" && args[i + 1]) {
      dumpPath = args[i + 1].trim();
      i++;
    }
  }

  return { targetUrl, manifestPath, dumpPath };
}

function parseUrlSafe(connectionString) {
  try {
    const parsed = new URL(connectionString);
    return {
      host: parsed.hostname || "localhost",
      port: parsed.port || "5432",
      database: parsed.pathname.replace(/^\//, "") || "",
    };
  } catch {
    throw new Error("Invalid target PostgreSQL connection URL.");
  }
}

async function verifyBackup() {
  const { targetUrl, manifestPath, dumpPath } = parseArgs();
  if (!targetUrl) {
    console.error("ERROR: --target-url is required.");
    process.exit(1);
  }
  if (!manifestPath) {
    console.error("ERROR: --manifest <path-to-manifest.json> is required.");
    process.exit(1);
  }

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file is missing: ${manifestPath}`);
  }

  const manifestData = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  console.log(`[Verify] Loaded source manifest for backupId=${manifestData.backupId}`);

  // Check dump checksum if dump path is provided or inferred
  const targetDumpPath =
    dumpPath ||
    path.join(path.dirname(manifestPath), manifestData.dumpFilename);

  if (fs.existsSync(targetDumpPath)) {
    const dumpBuffer = fs.readFileSync(targetDumpPath);
    const actualDumpChecksum = createHash("sha256").update(dumpBuffer).digest("hex");
    if (manifestData.dumpChecksum && actualDumpChecksum !== manifestData.dumpChecksum) {
      throw new Error(
        `Dump artifact SHA-256 checksum mismatch! Manifest=${manifestData.dumpChecksum.slice(0, 12)}... Actual=${actualDumpChecksum.slice(0, 12)}...`,
      );
    }
    console.log(`[Verify] Dump SHA-256 checksum verified OK (${actualDumpChecksum.slice(0, 12)}...)`);
  }

  const info = parseUrlSafe(targetUrl);
  console.log(`[Verify] Connecting read-only to target host=${info.host} database=${info.database}...`);

  const client = new pg.Client({ connectionString: targetUrl });
  await client.connect();

  let failed = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");

    // 1. Verify schema tables
    const tableListRes = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const existingTables = tableListRes.rows.map((r) => r.table_name);

    for (const expected of EXPECTED_TABLES) {
      if (!existingTables.includes(expected)) {
        console.error(`[Verify FAIL] Expected table missing: ${expected}`);
        failed = true;
      }
    }

    const unexpected = existingTables.filter((name) => !EXPECTED_TABLES.includes(name));
    if (unexpected.length > 0) {
      console.error(`[Verify FAIL] Unexpected public tables found: ${unexpected.join(", ")}`);
      failed = true;
    }

    // 2. Verify schema migrations
    const migrationRes = await client.query(
      "SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename",
    );
    const restoredMigrations = migrationRes.rows;

    if (restoredMigrations.length !== manifestData.migrations.length) {
      console.error(
        `[Verify FAIL] Migration count mismatch: source=${manifestData.migrations.length}, restored=${restoredMigrations.length}`,
      );
      failed = true;
    } else {
      for (let i = 0; i < manifestData.migrations.length; i++) {
        const src = manifestData.migrations[i];
        const res = restoredMigrations[i];
        if (src.filename !== res.filename || src.checksum !== res.checksum) {
          console.error(
            `[Verify FAIL] Migration mismatch on ${src.filename}: source checksum=${src.checksum.slice(0, 8)}, restored=${res.checksum.slice(0, 8)}`,
          );
          failed = true;
        }
      }
    }

    // 3. Compute target table fingerprints and row counts
    const targetTablesObj = {};
    const targetFingerprintsObj = {};

    for (const tableName of EXPECTED_TABLES) {
      const fp = await computeTableFingerprint(client, tableName);
      targetTablesObj[tableName] = fp.rowCount;
      targetFingerprintsObj[tableName] = fp.hash;
    }

    // 4. Compare source manifest vs target metrics 1:1
    for (const tableName of EXPECTED_TABLES) {
      const srcCount = manifestData.tables[tableName];
      const targetCount = targetTablesObj[tableName];
      if (srcCount !== targetCount) {
        console.error(
          `[Verify FAIL] Row count mismatch on ${tableName}: source=${srcCount}, restored=${targetCount}`,
        );
        failed = true;
      }

      const srcHash = manifestData.fingerprints[tableName];
      const targetHash = targetFingerprintsObj[tableName];
      if (srcHash !== targetHash) {
        console.error(
          `[Verify FAIL] Deterministic fingerprint mismatch on ${tableName}! source=${srcHash?.slice(0, 12)}... restored=${targetHash?.slice(0, 12)}...`,
        );
        failed = true;
      }
    }

    await client.query("COMMIT");

    if (failed) {
      throw new Error("Verification failed due to schema or manifest mismatches.");
    }

    console.log(`[Verify] SUCCESS! Restored database matches source manifest 100% across all 23 schema tables.`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith("verify-pg-backup.mjs")) {
  verifyBackup().catch((err) => {
    console.error(`[Verify FAILED] ${err.message}`);
    process.exit(1);
  });
}
