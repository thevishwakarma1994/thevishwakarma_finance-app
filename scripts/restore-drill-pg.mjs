#!/usr/bin/env node
/**
 * PostgreSQL isolated restore drill tool (Stage 15D).
 *
 * Safety Rules:
 * - Requires environment variable RESTORE_DRILL=1.
 * - Requires target database name to contain _restore_drill or restore_drill_.
 * - Refuses restoration if target matches production host or source DATABASE_URL.
 * - Restores into an isolated PostgreSQL database using pg_restore.
 * - Any non-zero exit code of pg_restore is treated as a fatal failure.
 */
import fs from "node:fs";
import { execSync, execFileSync } from "node:child_process";

function parseArgs() {
  const args = process.argv.slice(2);
  let targetUrl = "";
  let dumpPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target-url" && args[i + 1]) {
      targetUrl = args[i + 1].trim();
      i++;
    } else if (args[i] === "--dump" && args[i + 1]) {
      dumpPath = args[i + 1].trim();
      i++;
    }
  }

  return { targetUrl, dumpPath };
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

function checkPgRestoreInstalled() {
  try {
    execSync("pg_restore --version", { stdio: "ignore" });
  } catch {
    throw new Error(
      "pg_restore CLI binary is not available in PATH. Please install PostgreSQL client tools.",
    );
  }
}

function runRestoreDrill() {
  if (process.env.RESTORE_DRILL !== "1") {
    console.error("ERROR: RESTORE_DRILL=1 environment variable is required to execute restore drill.");
    process.exit(1);
  }

  const { targetUrl, dumpPath } = parseArgs();
  if (!targetUrl) {
    console.error("ERROR: --target-url is required.");
    process.exit(1);
  }
  if (!dumpPath) {
    console.error("ERROR: --dump <path-to-dump> is required.");
    process.exit(1);
  }

  checkPgRestoreInstalled();

  if (!fs.existsSync(dumpPath) || fs.statSync(dumpPath).size === 0) {
    throw new Error(`Dump file is missing or empty: ${dumpPath}`);
  }

  const targetInfo = parseUrlSafe(targetUrl);
  const sourceUrl = process.env.DATABASE_URL?.trim() || "";
  let sourceInfo = null;
  if (sourceUrl) {
    try {
      sourceInfo = parseUrlSafe(sourceUrl);
    } catch {
      // ignore
    }
  }

  // Safety Check 1: Target host/database must not match source DATABASE_URL
  if (sourceInfo && targetInfo.host === sourceInfo.host && targetInfo.database === sourceInfo.database) {
    console.error("ERROR: Target database matches source/production DATABASE_URL! ABORTING.");
    process.exit(1);
  }

  // Safety Check 2: Production host patterns
  if (targetInfo.host.includes("render.com") || targetInfo.host.includes("neon.tech")) {
    console.error("ERROR: Target host appears to be a production environment. ABORTING.");
    process.exit(1);
  }

  // Safety Check 3: Target database name must explicitly contain restore_drill
  const dbName = targetInfo.database.toLowerCase();
  const isDrillName = dbName.includes("_restore_drill") || dbName.includes("restore_drill_") || dbName === "restore_drill";
  if (!isDrillName) {
    console.error(
      `ERROR: Target database name "${targetInfo.database}" does not contain 'restore_drill'. Target database MUST be a non-production drill database (e.g. finance_restore_drill). ABORTING.`,
    );
    process.exit(1);
  }

  console.log(`[Restore Drill] Restoring ${dumpPath} into isolated target host=${targetInfo.host} database=${targetInfo.database}...`);

  try {
    execFileSync("pg_restore", [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
      `--dbname=${targetUrl}`,
      dumpPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    console.log("[Restore Drill] pg_restore executed successfully.");
  } catch (err) {
    console.error("[Restore Drill FAILED] pg_restore exited with non-zero error status.");
    throw err;
  }
}

if (process.argv[1] && process.argv[1].endsWith("restore-drill-pg.mjs")) {
  try {
    runRestoreDrill();
    console.log("[Restore Drill] Restoration complete. Proceed to verify integrity with pnpm db:verify-restore.");
  } catch (err) {
    console.error(`[Restore Drill FAILED] ${err.message}`);
    process.exit(1);
  }
}
