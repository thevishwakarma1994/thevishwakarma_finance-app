# Production PostgreSQL persistence

**Status:** Neon production PostgreSQL exists and the Stage 15A schema is applied. Render web service configuration is in `render.yaml`. Do not merge to `main`. Do not enter real financial data.

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

## Neon production database

The production database is a Neon PostgreSQL instance. It has been created and migrated with `drizzle-pg/0000_init.sql`.

Keep the real connection string only in host/environment configuration (`DATABASE_URL`). Do not put production `DATABASE_URL` in local `.env` while developing against SQLite (`pnpm dev` would then write to production).

Never commit, log, or paste the connection string into docs.

Placeholder only:

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DB?sslmode=require
```

SSL is taken from the connection string (`sslmode=require` on Neon URLs). Do not hard-code sslmode or credentials.

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

Production migrate requires `DATABASE_URL` already in the process environment (shell export or host secret). Do not add it to local `.env` for SQLite development.

```
NODE_ENV=production pnpm db:migrate
```

`pnpm db:migrate` loads `.env` for other vars; an exported `DATABASE_URL` takes precedence. Re-running the command is idempotent: no schema changes, no duplicate tables, no duplicate `schema_migrations` row, checksum stays valid.

Fresh production initialization:

1. Empty Neon production database (no unexpected tables or financial rows)
2. Export `DATABASE_URL` and production Firebase env on the host
3. `NODE_ENV=production pnpm db:migrate`
4. Confirm `schema_migrations` (see below)
5. Start the Node process (`pnpm start` after `pnpm build`). On Render this is the start command; locally export env vars (do not rely on a missing `.env` file).

There is no SQLite→Postgres data copy. There is no production financial data to migrate. PostgreSQL migrations do **not** seed `Development (legacy)` or sample accounts, categories, income, cards, people, obligations, or transactions.

---

## Verify migration status

Using a SQL client and the host-environment URL (do not echo it):

```sql
SELECT filename, checksum, applied_at FROM schema_migrations;
```

Expect one row: `0000_init.sql`, SHA-256 checksum (64 hex characters), `applied_at` set.

```sql
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM workspaces;
SELECT COUNT(*) FROM financial_events;
SELECT COUNT(*) FROM workspaces WHERE name = 'Development (legacy)';
```

Expect `0` until a real authenticated request provisions a user. Production must stay empty of users/workspaces until later deployment smoke testing.

---

## PostgreSQL contract tests (isolated target)

`tests/integration/stage15-postgres.test.ts` runs only when `TEST_DATABASE_URL` is set. It inserts fixtures and truncates data tables (not `schema_migrations`).

**Never point `TEST_DATABASE_URL` at the production database.** Use a separate Neon database or branch (schema-only or a copy parented on production). Test cleanup must not drop production objects.

Local `pnpm test` without `TEST_DATABASE_URL` stays on SQLite. The PostgreSQL file uses a longer Vitest timeout so remote Neon round-trips can finish; that is latency, not a financial-behavior change.

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

---

## Render web service

Blueprint: `render.yaml` (free Node web service). Same origin: Vite UI and Hono API on one Render hostname.

| | Command |
|---|---|
| Build | `pnpm install --frozen-lockfile --prod=false && pnpm build` |
| Start | `pnpm start` → `NODE_ENV=production tsx src/server.ts` |

`pnpm start` does **not** load a local `.env` file (that file does not exist on Render). Environment comes from the host.

Required Render env (dashboard secrets, never in git):

- `NODE_ENV=production`
- `DATABASE_URL` — Neon **production** database only. Never `TEST_DATABASE_URL`. Never the `contract-tests` branch.
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY` — PEM with `\n` for newlines
- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`
- optional: `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_STORAGE_BUCKET`
- `APP_ORIGIN` — `https://<service>.onrender.com` (same-origin `Host` matching also works)

Startup: open PostgreSQL → apply/check `drizzle-pg` migrations (idempotent, no legacy seed) → listen on `process.env.PORT` at `0.0.0.0`. SQLite is rejected.

After the hostname exists, add it to Firebase Authentication **Authorized domains**. Keep `localhost`.

Do not set `GOOGLE_APPLICATION_CREDENTIALS` to a laptop file path. Do not log secrets. Custom domain and backups belong to a later checkpoint.
