#!/usr/bin/env node
/**
 * Temporary Neon latency probe. Never prints DATABASE_URL or credentials.
 * Usage: DATABASE_URL=... node scripts/probe-pg-latency.mjs
 */
import { Client, Pool } from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

let hostSuffix = "(invalid)";
try {
  const host = new URL(url).hostname;
  hostSuffix = host.split(".").slice(-3).join(".");
  console.log(`host_kind=${host.endsWith(".neon.tech") ? "neon" : "other"}`);
  console.log(`host_suffix=${hostSuffix}`);
} catch {
  console.error("DATABASE_URL is not a valid URL");
  process.exit(1);
}

async function once(label) {
  const connectStarted = performance.now();
  const client = new Client({ connectionString: url });
  await client.connect();
  const connectMs = performance.now() - connectStarted;
  const queryStarted = performance.now();
  await client.query("SELECT 1 AS ok");
  const queryMs = performance.now() - queryStarted;
  await client.end();
  console.log(`${label}_connectMs=${connectMs.toFixed(1)}`);
  console.log(`${label}_select1Ms=${queryMs.toFixed(1)}`);
}

await once("cold_client");
await once("warm_client");

const pool = new Pool({ connectionString: url, max: 2 });
const poolConnectStarted = performance.now();
const pooled = await pool.connect();
const poolConnectMs = performance.now() - poolConnectStarted;
const pooledQueryStarted = performance.now();
await pooled.query("SELECT 1 AS ok");
const pooledQueryMs = performance.now() - pooledQueryStarted;
pooled.release();

const acquireStarted = performance.now();
const again = await pool.connect();
const acquireMs = performance.now() - acquireStarted;
const againQueryStarted = performance.now();
await again.query("SELECT COUNT(*)::int AS n FROM schema_migrations");
const schemaQueryMs = performance.now() - againQueryStarted;
again.release();
await pool.end();

console.log(`pool_first_connectMs=${poolConnectMs.toFixed(1)}`);
console.log(`pool_first_select1Ms=${pooledQueryMs.toFixed(1)}`);
console.log(`pool_reuse_acquireMs=${acquireMs.toFixed(1)}`);
console.log(`schema_migrations_countMs=${schemaQueryMs.toFixed(1)}`);
