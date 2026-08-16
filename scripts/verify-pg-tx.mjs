#!/usr/bin/env node
/**
 * Prove pool open, query, commit, rollback, and clean close.
 * Never prints the connection string.
 */
import { Pool } from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 2 });
const client = await pool.connect();
try {
  const ping = await client.query("SELECT 1 AS ok, current_database() AS db");
  console.log(`query_ok=${ping.rows[0].ok === 1}`);
  console.log(`connected_db=${ping.rows[0].db}`);

  await client.query("BEGIN");
  await client.query("CREATE TEMP TABLE tx_probe (id TEXT PRIMARY KEY, n INT NOT NULL)");
  await client.query("INSERT INTO tx_probe (id, n) VALUES ('commit-me', 1)");
  await client.query("COMMIT");

  const committed = await client.query("SELECT n FROM tx_probe WHERE id = 'commit-me'");
  console.log(`commit_visible=${committed.rows[0]?.n === 1}`);

  await client.query("BEGIN");
  await client.query("INSERT INTO tx_probe (id, n) VALUES ('rollback-me', 2)");
  await client.query("ROLLBACK");
  const rolled = await client.query("SELECT n FROM tx_probe WHERE id = 'rollback-me'");
  console.log(`rollback_hidden=${rolled.rows.length === 0}`);
} finally {
  client.release();
}
await pool.end();
console.log("pool_closed=true");
