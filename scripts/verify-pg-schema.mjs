#!/usr/bin/env node
/**
 * Verify Stage 15A production schema objects without printing credentials.
 */
import { Client } from "pg";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const expectedTables = [
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

const client = new Client({ connectionString: url });
await client.connect();

let failed = false;
function check(label, ok, detail = "") {
  if (!ok) failed = true;
  console.log(`${ok ? "ok" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`);
}

const tables = await client.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' ORDER BY table_name
`);
const existing = tables.rows.map((row) => row.table_name);
for (const name of expectedTables) {
  check(`table ${name}`, existing.includes(name));
}
const unexpected = existing.filter((name) => !expectedTables.includes(name));
check("no unexpected public tables", unexpected.length === 0, unexpected.join(",") || "");

const pks = await client.query(`
  SELECT tc.table_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
  ORDER BY tc.table_name
`);
const pkMap = new Map(pks.rows.map((row) => [row.table_name, row.column_name]));
for (const name of expectedTables) {
  check(`pk ${name}.id`, pkMap.get(name) === "id" || name === "schema_migrations", pkMap.get(name) ?? "missing");
}
check("pk schema_migrations.filename", pkMap.get("schema_migrations") === "filename");

const workspaceTables = expectedTables.filter(
  (name) => !["workspaces", "users", "workspace_memberships", "schema_migrations"].includes(name),
);
const cols = await client.query(`
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND column_name = 'workspace_id'
`);
const withWorkspace = new Set(cols.rows.map((row) => row.table_name));
for (const name of workspaceTables) {
  check(`workspace_id ${name}`, withWorkspace.has(name));
}
check("users has no workspace_id", !withWorkspace.has("users"));
check("workspaces has no workspace_id", !withWorkspace.has("workspaces"));

const uniques = await client.query(`
  SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname
`);
const defs = uniques.rows.map((row) => `${row.indexname} :: ${row.indexdef}`);
function hasIndex(name) {
  return uniques.rows.some((row) => row.indexname === name);
}
check("unique users_firebase_uid", hasIndex("users_firebase_uid"));
check("unique workspace_memberships_user_workspace", hasIndex("workspace_memberships_user_workspace"));
check("unique obligation_instances_template_due", hasIndex("obligation_instances_template_due"));
const obligationIdx = uniques.rows.find((row) => row.indexname === "obligation_instances_template_due");
check(
  "obligation partial unique WHERE template_id IS NOT NULL",
  Boolean(obligationIdx?.indexdef?.toLowerCase().includes("where") && obligationIdx.indexdef.includes("template_id IS NOT NULL")),
  obligationIdx?.indexdef ?? "missing",
);

const checks = await client.query(`
  SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
  WHERE contype = 'c' AND conrelid = 'reservations'::regclass
`);
check(
  "reservations remaining CHECK",
  checks.rows.some((row) => row.def.toLowerCase().includes("amount_original_paise")),
  checks.rows.map((row) => row.def).join(" | ") || "missing",
);

const fks = await client.query(`
  SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
  WHERE contype = 'f' AND connamespace = 'public'::regnamespace
  ORDER BY 1, 2
`);
check("foreign keys present", fks.rows.length > 0, `count=${fks.rows.length}`);
check(
  "users.firebase_uid unique index definition",
  Boolean(uniques.rows.find((row) => row.indexname === "users_firebase_uid")?.indexdef.includes("UNIQUE")),
);

const migrations = await client.query("SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename");
console.log(`schema_migrations_rows=${migrations.rows.length}`);
for (const row of migrations.rows) {
  console.log(`migration=${row.filename} checksum_len=${row.checksum.length} applied_at_set=${Boolean(row.applied_at)}`);
}

const dataCounts = {};
for (const name of expectedTables.filter((item) => item !== "schema_migrations")) {
  const count = await client.query(`SELECT COUNT(*)::int AS n FROM ${name}`);
  dataCounts[name] = count.rows[0].n;
}
const nonempty = Object.entries(dataCounts).filter(([, n]) => n > 0);
check("financial/user data empty", nonempty.length === 0, nonempty.map(([name, n]) => `${name}=${n}`).join(",") || "");

const legacy = await client.query("SELECT COUNT(*)::int AS n FROM workspaces WHERE name = $1", [
  "Development (legacy)",
]);
check("no Development (legacy) workspace", legacy.rows[0].n === 0);

await client.end();
console.log(failed ? "schema_verification=FAILED" : "schema_verification=PASSED");
process.exit(failed ? 1 : 0);
