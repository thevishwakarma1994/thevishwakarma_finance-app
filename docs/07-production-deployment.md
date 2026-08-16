# Stage 15A — Production PostgreSQL persistence

**Status:** PostgreSQL is the production database. SQLite remains the local/dev/test default until Stage 15B deployment. Do not deploy in this checkpoint.

Firebase remains authentication only. Neon is PostgreSQL infrastructure only.

---

## Dialect boundary

All SQLite vs PostgreSQL branching lives in `src/db`.

| Layer | Database knowledge |
|---|---|
| `src/domain` | None |
| `src/app` | Opaque `DbHandles` + async I/O only |
| `src/api` | Opaque `DbHandles` |
| `src/ui` | None |
| `src/db` | Drivers, schema, migrations, transactions, SQL |

The switch is `src/db/env.ts` → `openConfiguredDatabase()`:

- `DATABASE_URL` set → PostgreSQL (`pg` + Drizzle `node-postgres`)
- otherwise, non-production → SQLite (`better-sqlite3`)
- production without `DATABASE_URL` → process exits

Do not add `if (postgres)` / `if (sqlite)` in domain, app, API, or UI.

---

## PostgreSQL setup (Neon)

1. Create a Neon project. Copy the pooled or direct connection string.
2. Put it in the host environment as `DATABASE_URL`. Never commit it.
3. Use `sslmode=require` (Neon URLs already include this).

Placeholder only:

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DB?sslmode=require
```

---

## Environment

| Variable | Production | Local development |
|---|---|---|
| `DATABASE_URL` | Required postgres URL | Optional; if set, the process uses PostgreSQL |
| `DATABASE_PATH` | Ignored / forbidden as a fallback | SQLite file, default `data/app.sqlite` |
| `NODE_ENV` | `production` | `development` |
| Firebase vars | Unchanged from Stage 14 | Unchanged |

Startup logs `database backend=postgres` or `database backend=sqlite path=...`. It never logs `DATABASE_URL`.

---

## Migration command

```
pnpm db:migrate
```

Runs `src/db/migrate.ts`, which selects the backend from env:

- SQLite: applies `drizzle/*.sql` in order, then seeds `Development (legacy)` for local compatibility
- PostgreSQL: applies `drizzle-pg/*.sql` against an empty database. **No legacy seed.** First Firebase user still gets an empty Personal workspace.

Fresh production initialization:

1. Empty Neon database
2. Set `DATABASE_URL` and production Firebase env
3. `pnpm db:migrate`
4. Start the Node process (`pnpm start` after a UI build)

There is no SQLite→Postgres data copy in this stage. There is no production financial data to migrate.

---

## Rollback expectations

PostgreSQL migrations are forward-only SQL files recorded in `schema_migrations` as `(filename, checksum, applied_at)`.

- The same filename is never applied twice.
- If the file contents change after apply, startup fails on checksum mismatch.
- If a migration fails, the transaction is rolled back and the filename is not recorded.
- After apply, the process asserts that every `drizzle-pg/*.sql` file is present with a matching checksum. Production cannot serve against an incomplete or drifted schema.

Restore the previous application version and keep the last successfully applied schema. Do not hand-edit `schema_migrations`.

SQLite local files can be deleted and recreated (`rm data/app.sqlite*` then `pnpm db:migrate`).

---

## Local SQLite strategy

Keep using SQLite for `pnpm dev` and `pnpm test` unless `DATABASE_URL` / `TEST_DATABASE_URL` is set.

- WAL, `foreign_keys=ON`, `busy_timeout=5000` remain isolated in `src/db/client.ts`
- Existing `drizzle/0000`–`0008` files stay for local compatibility
- Tests use `openMemoryDatabase()` unless a PostgreSQL contract test opts in

---

## Production PostgreSQL strategy

- Driver: `pg` Pool (Node/Hono). SSL comes from `DATABASE_URL` (`sslmode=require` on Neon URLs). No hard-coded credentials or sslmode.
- Amounts: `BIGINT` integer paise. Domain `Paise` remains a JS number. Reads validate the raw BIGINT (string/bigint) with `fromStoredPaise` before conversion. Unsafe values are rejected; they are never silently rounded.
- Civil dates and audit timestamps: `TEXT` (`YYYY-MM-DD` / ISO-8601 UTC)
- Boolean flags: `INTEGER` 0/1, mapped to JS `boolean` in loaders
- IDs: application-generated UUIDv7 TEXT
- One financial command = one database transaction (`src/db/tx.ts` + `persistBatch`)
- Obligation materialization uses `INSERT ... ON CONFLICT DO NOTHING` against the partial unique index `(workspace_id, template_id, due_on) WHERE template_id IS NOT NULL`

Render, backups, custom domain, and live Neon data entry belong to Stage 15B.
