#!/usr/bin/env node
/**
 * Reset public schema on an isolated TEST PostgreSQL target, then stop.
 * Refuses to run unless ALLOW_DROP_PUBLIC_SCHEMA=yes.
 * Refuses if the URL host matches PRODUCTION_GUARD_HOST.
 * Never prints the connection string.
 */
import { Client } from "pg";

if (process.env.ALLOW_DROP_PUBLIC_SCHEMA !== "yes") {
  console.error("refused: ALLOW_DROP_PUBLIC_SCHEMA=yes is required");
  process.exit(1);
}

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error("DATABASE_URL is not a valid URL");
  process.exit(1);
}

const host = parsed.hostname;
const guard = process.env.PRODUCTION_GUARD_HOST?.trim();
if (!guard) {
  console.error("refused: PRODUCTION_GUARD_HOST is required");
  process.exit(1);
}
if (host === guard) {
  console.error("refused: target host matches production guard host");
  process.exit(1);
}
if (!host.endsWith(".neon.tech")) {
  console.error("refused: expected a Neon host");
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();
await client.query("DROP SCHEMA public CASCADE");
await client.query("CREATE SCHEMA public");
await client.query("GRANT ALL ON SCHEMA public TO public");
await client.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
await client.end();
console.log("test_schema_reset=ok");
console.log("host_kind=neon");
console.log(`database=${parsed.pathname.replace(/^\//, "").split("?")[0]}`);
