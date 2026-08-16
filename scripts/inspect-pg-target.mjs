#!/usr/bin/env node
/**
 * Inspect a PostgreSQL target without printing credentials.
 * Usage: DATABASE_URL=... node scripts/inspect-pg-target.mjs
 */
import { Client } from "pg";

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
const database = parsed.pathname.replace(/^\//, "").split("?")[0];
const sslmode = parsed.searchParams.get("sslmode");
const isNeon = host.endsWith(".neon.tech");
const isLocal = host === "localhost" || host === "127.0.0.1";

console.log(`host_kind=${isNeon ? "neon" : isLocal ? "local" : "other"}`);
console.log(`host_suffix=${host.split(".").slice(-3).join(".")}`);
console.log(`database=${database}`);
console.log(`sslmode=${sslmode ?? "(unset)"}`);
console.log(`pooled=${host.startsWith("ep-") || parsed.hostname.includes("-pooler") ? "maybe" : "unknown"}`);

const client = new Client({ connectionString: url });
await client.connect();

const version = await client.query("SELECT current_database() AS db, current_user AS role, inet_server_addr() IS NOT NULL AS has_addr");
console.log(`connected_db=${version.rows[0].db}`);
console.log(`connected_role=${version.rows[0].role}`);

const tables = await client.query(`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
  ORDER BY table_name
`);
console.log(`public_table_count=${tables.rows.length}`);
console.log(`public_tables=${tables.rows.map((row) => row.table_name).join(",") || "(none)"}`);

const expected = [
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

const existing = new Set(tables.rows.map((row) => row.table_name));
for (const name of expected) {
  if (!existing.has(name)) {
    console.log(`count.${name}=missing`);
    continue;
  }
  const count = await client.query(`SELECT COUNT(*)::int AS n FROM ${name}`);
  console.log(`count.${name}=${count.rows[0].n}`);
}

const unexpected = tables.rows
  .map((row) => row.table_name)
  .filter((name) => !expected.includes(name));
console.log(`unexpected_tables=${unexpected.join(",") || "(none)"}`);

await client.end();
console.log("pool_closed=true");
