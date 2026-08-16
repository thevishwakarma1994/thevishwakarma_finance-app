# Stage 5 — Technical Architecture & Persistence

**Status:** Stage 14 — Firebase Auth adapter + per-user Personal workspaces. SQLite remains the financial database. Do not migrate to PostgreSQL or deploy in this stage.

**Locked inputs:** `docs/04-financial-domain-model.md` (behaviour), `docs/03-information-architecture-ux.md` (UX). Shopping/receipts: `docs/06-shopping-receipts-amendment.md`. This document does not restate financial rules.

**Repository inspection (2026-08-16):** The Finance folder contains only `docs/`. No application, package.json, schema, or CI. Available locally: Node 22, pnpm, Python 3.13, sqlite3, psql, Docker 27. Python is unused. No mobile project exists.

---

## 1. Recommended stack

Phone-first means capture from a phone. That requires an HTTP app, not a laptop-only SQLite GUI.


| Layer      | Choice                                                                                     | Why                                                                  | Rejected                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Language   | TypeScript (strict)                                                                        | One language for UI, API, domain, tests                              | Python: weaker shared types across UI/engine                                                 |
| UI         | Vite + React 19 + CSS modules (or vanilla-extract)                                         | Fast local loop, PWA-capable, no RSC cache surprises around money    | Next.js: extra caching/runtime for no SEO need. Expo: store + native tax for a personal tool |
| API        | Hono, same Node process as static UI                                                       | Tiny, typed middleware                                               | Separate Nest/Express service: ceremony                                                      |
| Domain     | Pure TS package folder `src/domain`                                                        | Testable with no HTTP, no DB, no React                               | Calculations inside components                                                               |
| DB         | SQLite 3, WAL, `PRAGMA foreign_keys=ON`                                                    | One user, ACID, zero daemon locally, file backup                     | Postgres V1: extra process. Browser-SQLite: backup/corruption risk                           |
| Driver     | `better-sqlite3`                                                                           | Synchronous transactions; no interleaved awaits inside a money write | async `sql.js`                                                                               |
| ORM        | Drizzle                                                                                    | SQL-shaped, typed, no hidden N+1 magic                               | Prisma: heavier, worse for custom invariants                                                 |
| Validation | Zod                                                                                        | Shared request + domain input schemas                                |                                                                                              |
| IDs        | UUIDv7 (TEXT)                                                                              | Sortable, import-friendly later                                      | Auto-increment ints                                                                          |
| Money      | branded `Paise` integer                                                                    | Never `number` rupees in domain                                      |                                                                                              |
| Tests      | Vitest                                                                                     | Domain unit + SQLite integration in one runner                       | Jest                                                                                         |
| E2E        | Playwright, few smoke paths                                                                | After Home exists                                                    | Heavy Cypress                                                                                |
| Auth       | Firebase Auth adapter (`src/api/auth` only): Google + email/password                       | External identity stays out of the financial engine                  | Password session, client-supplied uid/workspaceId, phone OTP (later)                         |
| Deploy     | One Node service + SQLite volume (Fly.io or equivalent) + file backup (Litestream → R2/S3) | Phone can reach it; ~one machine                                     | Kubernetes, serverless DB, multi-tenant infra                                                |
| Local      | `pnpm dev`: Vite + Hono + `data/app.sqlite`                                                | Seconds to start                                                     | Docker Compose required for hello-world                                                      |


**Not a monorepo.** One package:

```
src/domain     pure engine (no drizzle, no react, no workspace/user/auth types)
src/db         schema, migrations, snapshot loader (workspace-scoped SQL)
src/app        command handlers: resolve workspace → load snapshot → domain → persist
src/api        Hono routes + Firebase token verification only
src/ui         React, talks only to /api
tests/domain
tests/integration
```

UI must not import `src/db` or writing commands. It may import `src/domain/types` and display-format helpers only.

**Ownership boundary:** Firebase is an authentication adapter, not the financial database. Verified identity maps to an internal user and membership; the engine still sees only a workspace ledger.

```
Firebase ID token
  → Admin verifyIdToken() → firebase uid
  → internal User → WorkspaceMembership → Workspace
  → WorkspaceContext { workspaceId }
  → src/app / src/db: loadSnapshot(workspaceId)
  → src/domain: evaluate / command(snapshot)   // no workspaceId, no userId, no firebaseUid
  → src/db: persistBatch(workspaceId, batch)
```

V1: each newly provisioned Firebase user receives exactly one empty Personal workspace as `owner`. The Stage 1–13 development book is preserved as `Development (legacy)` and is **not** attached to new users.

---



## 2. Module boundaries

```
src/domain
  money/           Paise, parse/format INR
  calendar/        Asia/Kolkata DATE helpers
  conservation/    per-meaning identities
  ledger/          types: Event, Posting, Claim, Reservation, …
  cycleAssign/     card purchase → billing cycle; due → funding cycle
  commands/        pure: input + LedgerSnapshot → ProposedBatch + ConsequencePreview
  engine/
    evaluateSafeToSpend.ts
    simulateAffordability.ts
    inclusion.ts          Q1 delayed/window rules (locked in Stage 4)

src/db
  schema.ts
  migrate.ts
  loadSnapshot.ts         (workspaceId) → LedgerSnapshot
  persistBatch.ts         (workspaceId, ProposedBatch) → rows, inside a transaction

src/app
  context.ts              WorkspaceContext { workspaceId } from membership; never imported by domain
  recordSplit.ts          Zod → loadSnapshot(workspaceId) → domain.command → conserve → persist
  …one file per command

src/api
  auth/                   Bearer Firebase ID token → verifyIdToken → provision User/membership
  routes/commands.ts
  routes/reads.ts

src/ui
  routes: Home, Activity, People, Money, overlays
  apiClient.ts
```

**Engine rule:** `evaluateSafeToSpend` and `simulateAffordability` accept an in-memory `LedgerSnapshot` (plus `asOf: IsoDate`). They never touch SQLite, `fetch`, workspace ids, or auth.

**Write path:** Route (auth) → `src/app` (workspaceId) → domain (pure snapshot) → conservation → `db.transaction(persistBatch(workspaceId, …))`.

**Read path:** Route (auth → workspaceId) → SQL scoped by `workspace_id` / `loadSnapshot(workspaceId)` → DTO or engine. Home STS: snapshot → `evaluateSafeToSpend` (no workspace argument).

Future bank/SMS import **and** receipt/product providers are adapters that emit command inputs or drafts. They sit outside `src/domain`. Ports: `ReceiptExtractor`, `ProductIdentifier` — see `docs/06-shopping-receipts-amendment.md`.

---



## 3. Persistence model

SQLite. Amounts: `INTEGER` paise, never REAL. IDs: application-generated UUIDv7 stored as `TEXT` (portable to Postgres `UUID`/`TEXT`).

Calendar dates: `TEXT` `YYYY-MM-DD` (Kolkata civil date). Instants: `TEXT` ISO-8601 UTC.

JSON: only for variant payloads (`opening_positions.payload`, `config_versions.value`, `billing_cycles.rule_snapshot`). Validated with Zod in application code, not with SQLite JSON1.

Do **not** persist Safe to Spend, person net, account available, or claim `open_amount`.

Domain types (`Paise`, `IsoDate`, ledger structs) live in `src/domain`. Drizzle row types stay in `src/db` and are mapped at the snapshot boundary. SQLite affinities must not leak into domain (no `INTEGER` 0/1 flags in engine code — map to `boolean` in the loader).

### 3.0 Workspace ownership

Financial tables remain workspace-scoped. Identity lives beside them, not on events or postings.

```
workspaces
  id TEXT PK
  name TEXT NOT NULL  -- "Personal" for new users; existing book renamed "Development (legacy)"
  created_at TEXT NOT NULL

users
  id TEXT PK                 -- application UUIDv7
  firebase_uid TEXT UNIQUE   -- external identity only
  display_name TEXT
  primary_email TEXT
  status TEXT NOT NULL       -- active | disabled
  created_at, updated_at TEXT

workspace_memberships
  id TEXT PK
  user_id TEXT FK users
  workspace_id TEXT FK workspaces
  role TEXT NOT NULL         -- V1: owner; enum-shaped for later roles
  created_at TEXT
  UNIQUE (user_id, workspace_id)
```

Every financial table listed in §3.1 (including child tables: postings, event_shares, allocations, reservation_ledger) has:

```
workspace_id TEXT NOT NULL REFERENCES workspaces(id)
```

`src/db` sets `workspace_id` on insert from `WorkspaceContext`. Clients cannot choose it. Queries for money always include `WHERE workspace_id = ?`. Command IDs (account, card, person, claim, cycle, obligation, category, …) are also checked with reusable workspace-ownership validation before persist.

Unique keys that are “one per book” become composite with `workspace_id` (e.g. funding cycle `(workspace_id, year, month)`, budgets `(workspace_id, category_id, year, month)`, openings `(workspace_id, kind, subject_id)`, billing `(workspace_id, credit_card_id, expected_statement_on)`, at most one primary salary account per workspace — **application-enforced** uniqueness, not a SQLite partial index).

First valid Firebase request is idempotent: find `users.firebase_uid`, else create User + Personal workspace + owner membership. Repeated login must not create another workspace. Shared workspaces, invitations, and switching UI are not implemented.

The pre-auth development workspace is preserved and left unowned. Do not auto-assign it to the first Firebase account. A later one-time admin assignment can attach it if needed.

### 3.1 Tables



#### `accounts`

Purpose: bank, cash, investment instruments.


| Column            | Type                       | Notes                           |
| ----------------- | -------------------------- | ------------------------------- |
| id                | TEXT PK                    |                                 |
| kind              | TEXT NOT NULL              | enum `bank | cash | investment` |
| display_name      | TEXT NOT NULL              |                                 |
| mask              | TEXT                       |                                 |
| is_primary_salary | INTEGER NOT NULL DEFAULT 0 | 0/1                             |
| status            | TEXT NOT NULL              | `active | archived`             |
| created_at        | TEXT NOT NULL              | UTC                             |


Indexes: `(workspace_id, kind, status)`. One primary salary account per workspace: enforce in `src/app` on write, not a vendor-specific partial unique index.

#### `credit_cards`


| Column                     | Type           | Notes               |
| -------------------------- | -------------- | ------------------- |
| id                         | TEXT PK        |                     |
| display_name, issuer, mask | TEXT           |                     |
| credit_limit_paise         | INTEGER        | nullable            |
| default_owner_person_id    | TEXT FK people | nullable = user     |
| status                     | TEXT           | `active | inactive` |
| created_at                 | TEXT           | UTC                 |


Statement/due rules live in `config_versions`, not here, so they can be effective-dated. Optional denormalized “current” columns are forbidden; read as-of from config.

#### `loans`


| Column     | Type          | Notes               |
| ---------- | ------------- | ------------------- |
| id         | TEXT PK       |                     |
| name       | TEXT NOT NULL |                     |
| status     | TEXT          | `active | archived` |
| created_at | TEXT          |                     |


EMI amount, remaining tenure, next due: `config_versions` + `opening_positions` + postings. Do not store a mutable `outstanding` column that can drift; derive from opening + loan-target postings.

#### `people`


| Column     | Type          | Notes               |
| ---------- | ------------- | ------------------- |
| id         | TEXT PK       |                     |
| name       | TEXT NOT NULL |                     |
| status     | TEXT          | `active | archived` |
| notes      | TEXT          |                     |
| created_at | TEXT          |                     |


No `balance` column.

#### `categories`


| Column      | Type               | Notes        |
| ----------- | ------------------ | ------------ |
| id          | TEXT PK            |              |
| parent_id   | TEXT FK categories | nullable     |
| name        | TEXT NOT NULL      |              |
| archived_at | TEXT               | UTC nullable |


Unique `(workspace_id, parent_id, name)` among non-archived rows: **application-enforced** (portable). Index `(workspace_id, parent_id)`.

#### `channels`

Optional tiny lookup (`id`, `label`, `archived_at`). Events store `channel_id`. If this feels heavy, store `channel` TEXT with a CHECK against a code list and skip the table. **Recommendation:** TEXT + CHECK in V1 (`gpay`, `phonepe`, `upi`, `rupay_upi`, `card`, `atm`, `cash`, `other`). Editable list later = this table.

#### `financial_events`

Immutable header after commit. Corrections = reversing event (`reversal_of_event_id`), not in-place amount edits (except a guarded admin correction command that still writes a reversal internally).


| Column               | Type                     | Notes                                    |
| -------------------- | ------------------------ | ---------------------------------------- |
| id                   | TEXT PK                  |                                          |
| meaning              | TEXT NOT NULL            | enum: Stage 4 engine keys                |
| occurred_on          | TEXT NOT NULL            | DATE Kolkata                             |
| captured_at          | TEXT NOT NULL            | UTC                                      |
| amount_paise         | INTEGER NOT NULL         | header total; conservation uses postings |
| account_id           | TEXT FK accounts         | nullable                                 |
| credit_card_id       | TEXT FK credit_cards     | nullable                                 |
| loan_id              | TEXT FK loans            | nullable                                 |
| billing_cycle_id     | TEXT FK billing_cycles   | nullable                                 |
| funding_cycle_id     | TEXT FK funding_cycles   | nullable; stored once assigned           |
| category_id          | TEXT FK categories       | nullable                                 |
| channel              | TEXT                     |                                          |
| merchant             | TEXT                     |                                          |
| notes                | TEXT                     |                                          |
| reversal_of_event_id | TEXT FK financial_events | nullable                                 |


Indexes: `(workspace_id, occurred_on)`, `(workspace_id, meaning, occurred_on)`, `(credit_card_id, billing_cycle_id)`, `(account_id, occurred_on)`.

CHECK: `amount_paise >= 0` for header (direction lives on postings).

#### `event_shares`

EventShare rows. Needed to reconstruct splits without parsing notes.


| Column       | Type                              | Notes           |
| ------------ | --------------------------------- | --------------- |
| id           | TEXT PK                           |                 |
| event_id     | TEXT FK events ON DELETE RESTRICT |                 |
| person_id    | TEXT FK people                    | nullable = user |
| amount_paise | INTEGER NOT NULL                  |                 |
| is_user      | INTEGER NOT NULL                  | 0/1             |


Unique `(event_id, person_id)` (person_id NULL for user: use `is_user` unique per event). Index `(event_id)`.

#### `postings`


| Column           | Type                    | Notes                                                          |
| ---------------- | ----------------------- | -------------------------------------------------------------- |
| id               | TEXT PK                 |                                                                |
| event_id         | TEXT FK events NOT NULL |                                                                |
| amount_paise     | INTEGER NOT NULL        | signed                                                         |
| account_id       | TEXT FK                 | nullable                                                       |
| credit_card_id   | TEXT FK                 | nullable                                                       |
| loan_id          | TEXT FK                 | nullable                                                       |
| pnl              | TEXT                    | nullable `income_salary | income_other | expense | investment` |
| category_id      | TEXT FK                 | when pnl = expense                                             |
| claim_id         | TEXT FK claims          | nullable                                                       |
| billing_cycle_id | TEXT FK                 | nullable                                                       |


CHECK: exactly one of (`account_id`, `credit_card_id`, `loan_id`, `pnl`) is non-null. (Claim-only postings still set `claim_id` **and** may set account/card/pnl per Stage 4 templates — **implementation:** allow `claim_id` in combination; the XOR is among balance targets `{account, card, loan, pnl}`.)

Indexes: `(event_id)`, `(account_id)`, `(credit_card_id, billing_cycle_id)`, `(claim_id)`, `(pnl, category_id)`.

#### `claims`


| Column                | Type                      | Notes                                          |
| --------------------- | ------------------------- | ---------------------------------------------- |
| id                    | TEXT PK                   |                                                |
| person_id             | TEXT FK NOT NULL          |                                                |
| direction             | TEXT NOT NULL             | `they_owe_user | user_owes_them`               |
| kind                  | TEXT NOT NULL             | Stage 4 kinds                                  |
| original_amount_paise | INTEGER NOT NULL          | immutable snapshot                             |
| originating_event_id  | TEXT FK events            | nullable for opening-sourced                   |
| opening_position_id   | TEXT FK opening_positions | nullable                                       |
| billing_cycle_id      | TEXT FK                   | nullable                                       |
| obligation_ref_type   | TEXT                      | `billing_cycle | obligation_instance` nullable |
| obligation_ref_id     | TEXT                      | nullable                                       |
| note                  | TEXT                      |                                                |
| status                | TEXT NOT NULL             | `open | settled | void`                        |


No `open_amount_paise`. Index `(person_id, status)`, `(billing_cycle_id)`, `(originating_event_id)`.

#### `settlement_allocations`


| Column              | Type                    | Notes    |
| ------------------- | ----------------------- | -------- |
| id                  | TEXT PK                 |          |
| event_id            | TEXT FK events NOT NULL |          |
| claim_id            | TEXT FK claims NOT NULL |          |
| amount_paise        | INTEGER NOT NULL        | > 0      |
| creates_reservation | INTEGER NOT NULL        | 0/1      |
| reservation_id      | TEXT FK reservations    | nullable |


Unique `(event_id, claim_id)`. Index `(claim_id)`.

#### `reservations`


| Column                    | Type                       | Notes                                 |
| ------------------------- | -------------------------- | ------------------------------------- |
| id                        | TEXT PK                    |                                       |
| source_account_id         | TEXT FK accounts NOT NULL  |                                       |
| amount_original_paise     | INTEGER NOT NULL           | immutable                             |
| amount_consumed_paise     | INTEGER NOT NULL DEFAULT 0 |                                       |
| amount_released_paise     | INTEGER NOT NULL DEFAULT 0 |                                       |
| amount_reassigned_paise   | INTEGER NOT NULL DEFAULT 0 |                                       |
| amount_surplus_held_paise | INTEGER NOT NULL DEFAULT 0 |                                       |
| status                    | TEXT NOT NULL              | Stage 4 statuses                      |
| obligation_ref_type       | TEXT NOT NULL              | `billing_cycle | obligation_instance` |
| obligation_ref_id         | TEXT NOT NULL              |                                       |
| originating_event_id      | TEXT FK events             |                                       |
| originating_claim_id      | TEXT FK claims             |                                       |
| created_on                | TEXT NOT NULL              | DATE                                  |


CHECK: remaining identity `original - consumed - released - reassigned - surplus_held >= 0`.

Index `(source_account_id, status)`, `(obligation_ref_type, obligation_ref_id)`.

Remaining is derived in SQL:  
`amount_original_paise - amount_consumed_paise - amount_released_paise - amount_reassigned_paise - amount_surplus_held_paise`.

#### `reservation_ledger`

Append-only mutations.


| Column                   | Type                       | Notes |
| ------------------------ | -------------------------- | ----- |
| id                       | TEXT PK                    |       |
| reservation_id           | TEXT FK NOT NULL           |       |
| event_id                 | TEXT FK NOT NULL           |       |
| delta_consumed_paise     | INTEGER NOT NULL DEFAULT 0 |       |
| delta_released_paise     | INTEGER NOT NULL DEFAULT 0 |       |
| delta_reassigned_paise   | INTEGER NOT NULL DEFAULT 0 |       |
| delta_surplus_held_paise | INTEGER NOT NULL DEFAULT 0 |       |
| created_at               | TEXT NOT NULL              | UTC   |


Index `(reservation_id, created_at)`.

#### `surplus_cases`


| Column               | Type             | Notes                                                             |
| -------------------- | ---------------- | ----------------------------------------------------------------- |
| id                   | TEXT PK          |                                                                   |
| amount_paise         | INTEGER NOT NULL |                                                                   |
| kind                 | TEXT NOT NULL    | `reservation_excess | unallocated_settlement | claim_overpayment` |
| source_account_id    | TEXT FK          | nullable if not yet parked                                        |
| person_id            | TEXT FK          | nullable                                                          |
| reservation_id       | TEXT FK          | nullable                                                          |
| event_id             | TEXT FK          |                                                                   |
| explanation          | TEXT NOT NULL    | generated                                                         |
| status               | TEXT NOT NULL    | `pending | resolved`                                              |
| resolution           | TEXT             | Stage 4 codes, nullable until resolved                            |
| resolved_at          | TEXT             | UTC                                                               |
| resolved_by_event_id | TEXT FK          |                                                                   |


Index `(status)`, `(person_id, status)`.

#### `billing_cycles`


| Column                        | Type                       | Notes                                                                                                                                                                       |
| ----------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                            | TEXT PK                    |                                                                                                                                                                             |
| credit_card_id                | TEXT FK NOT NULL           |                                                                                                                                                                             |
| purchase_window_start         | TEXT NOT NULL              | DATE                                                                                                                                                                        |
| purchase_window_end           | TEXT NOT NULL              | DATE                                                                                                                                                                        |
| expected_statement_on         | TEXT NOT NULL              | DATE                                                                                                                                                                        |
| actual_statement_on           | TEXT                       | DATE                                                                                                                                                                        |
| expected_due_on               | TEXT NOT NULL              | DATE                                                                                                                                                                        |
| actual_due_on                 | TEXT                       | DATE                                                                                                                                                                        |
| expected_amount_paise         | INTEGER                    | derived cache optional — **V1: compute from postings; do not store**                                                                                                        |
| actual_statement_amount_paise | INTEGER                    | nullable until confirmed                                                                                                                                                    |
| amount_paid_paise             | INTEGER NOT NULL DEFAULT 0 | updated only inside pay-card transaction, or derived from postings. **Prefer derived from card postings on this cycle.** V1: derive; drop this column if queries stay cheap |
| status                        | TEXT NOT NULL              | Stage 4 statuses                                                                                                                                                            |
| funding_cycle_id              | TEXT FK                    | assigned from due date                                                                                                                                                      |
| rule_snapshot                 | TEXT NOT NULL              | JSON: statement_day, due_rule used; **immutable** after first spend attached                                                                                                |


Unique `(credit_card_id, expected_statement_on)` within a workspace (`workspace_id` on the row). Index `(workspace_id, credit_card_id, status)`, `(expected_due_on)`, `(funding_cycle_id)`.

#### `obligation_templates`


| Column             | Type          | Notes                              |
| ------------------ | ------------- | ---------------------------------- |
| id                 | TEXT PK       |                                    |
| name               | TEXT NOT NULL |                                    |
| priority           | TEXT NOT NULL | `must_pay | committed | planned`   |
| due_rule           | TEXT NOT NULL | JSON small: `{ "dayOfMonth": 18 }` |
| default_account_id | TEXT FK       | nullable                           |
| loan_id            | TEXT FK       | nullable                           |
| effective_from     | TEXT NOT NULL | DATE                               |
| effective_to       | TEXT          | DATE exclusive, nullable = open    |


Amount is effective-dated: either columns on this row **or** `config_versions` key `obligation.amount` + subject_id. **V1:** `amount_paise` on the template row **plus** a new template row (or config version) when amount changes from a date — prefer `config_versions` so templates are not duplicated. Store identity here; store amount timeline in config.

Index `(effective_from, effective_to)`.

#### `obligation_instances`


| Column            | Type             | Notes                   |
| ----------------- | ---------------- | ----------------------- |
| id                | TEXT PK          |                         |
| template_id       | TEXT FK          | nullable if one-off     |
| due_on            | TEXT NOT NULL    | DATE                    |
| amount_paise      | INTEGER NOT NULL | **snapshot** immutable  |
| priority_snapshot | TEXT NOT NULL    | immutable               |
| status            | TEXT NOT NULL    | `open | paid | skipped` |
| funding_cycle_id  | TEXT FK          |                         |
| paid_event_id     | TEXT FK events   | nullable                |


Unique `(workspace_id, template_id, due_on)` where template_id IS NOT NULL (application-enforced if the SQL dialect cannot express the null-template case portably). Index `(workspace_id, due_on, status)`, `(funding_cycle_id)`.

#### `income_policies`


| Column                | Type             | Notes      |
| --------------------- | ---------------- | ---------- |
| id                    | TEXT PK          |            |
| expected_amount_paise | INTEGER NOT NULL |            |
| window_start_day      | INTEGER NOT NULL | 4          |
| window_end_day        | INTEGER NOT NULL | 8          |
| typical_day           | INTEGER          | 5, display |
| effective_from        | TEXT NOT NULL    | DATE       |
| effective_to          | TEXT             | DATE       |


No overlapping `effective_from` ranges **per workspace** (application check on insert).

#### `funding_cycles`


| Column                | Type             | Notes                                                                  |
| --------------------- | ---------------- | ---------------------------------------------------------------------- |
| id                    | TEXT PK          |                                                                        |
| year                  | INTEGER NOT NULL |                                                                        |
| month                 | INTEGER NOT NULL | 1–12, window month                                                     |
| expected_window_start | TEXT NOT NULL    | DATE                                                                   |
| expected_window_end   | TEXT NOT NULL    | DATE                                                                   |
| expected_amount_paise | INTEGER NOT NULL | **snapshot** from policy at generation                                 |
| actual_arrival_on     | TEXT             | DATE                                                                   |
| actual_amount_paise   | INTEGER          |                                                                        |
| salary_event_id       | TEXT FK events   |                                                                        |
| status                | TEXT NOT NULL    | `upcoming | window_open_unreceived | salary_delayed | active | closed` |


Unique `(workspace_id, year, month)`. Index `(workspace_id, expected_window_start)`.

Status is **derived-capable** from `asOf` + actual_arrival. Persist for query convenience but **recompute on read** from dates + salary event so a missed cron cannot leave a stale `upcoming` after the 8th. Writer may update status inside salary and a daily “asOf tick” command. Safer V1: **derive status in domain from stored dates**; column is optional cache. **Recommendation:** store dates and actuals; **derive status in** `src/domain` every time. Drop `status` column to avoid drift, or keep it with a check that tests recompute equality.

**Decision (this doc’s default):** persist `actual_`* only; **derive** `status` in domain. Avoids delayed-salary bugs from stale rows.

#### `budgets`


| Column       | Type                         | Notes |
| ------------ | ---------------------------- | ----- |
| id           | TEXT PK                      |       |
| category_id  | TEXT FK NOT NULL             |       |
| year         | INTEGER NOT NULL             |       |
| month        | INTEGER NOT NULL             |       |
| amount_paise | INTEGER NOT NULL             |       |
| rollover     | TEXT NOT NULL DEFAULT `none` |       |


Unique `(workspace_id, category_id, year, month)`.

#### `opening_positions`


| Column       | Type          | Notes                                   |
| ------------ | ------------- | --------------------------------------- |
| id           | TEXT PK       |                                         |
| effective_on | TEXT NOT NULL | DATE                                    |
| kind         | TEXT NOT NULL | `account | credit_card | person | loan` |
| subject_id   | TEXT NOT NULL | id of account/card/person/loan          |
| payload      | TEXT NOT NULL | JSON, Zod per kind                      |
| created_at   | TEXT NOT NULL | UTC                                     |


Unique `(workspace_id, kind, subject_id)` for V1 (one opening per subject per workspace). Index `(workspace_id, effective_on)`.

Payload shapes (Zod): account `{ balance_paise }`; card `{ outstanding_paise, statement_balance_paise?, unbilled_paise?, statement_on?, due_on? }`; person `{ direction, amount_paise, note? }`; loan `{ outstanding_principal_paise, remaining_tenure, current_emi_paise, next_due_on }`.

Applying an opening **creates** the seeded claim / cycle / implicit opening postings **inside one transaction** (see §4). Activity shows a single “Opening” row per position, not fake merchants.

#### `config_versions`


| Column         | Type          | Notes                                                           |
| -------------- | ------------- | --------------------------------------------------------------- |
| id             | TEXT PK       |                                                                 |
| key            | TEXT NOT NULL | e.g. `card.statement_day`, `obligation.amount`, `card.due_rule` |
| subject_id     | TEXT NOT NULL | card/template/loan id                                           |
| effective_from | TEXT NOT NULL | DATE                                                            |
| effective_to   | TEXT          | DATE exclusive                                                  |
| value          | TEXT NOT NULL | JSON                                                            |


Index `(workspace_id, key, subject_id, effective_from)`. No overlapping intervals per `(workspace_id, key, subject_id)`.

Auth tables are `users` and `workspace_memberships` (§3.0). The previous password `sessions` table is removed. Firebase ID tokens are verified on each request and are not stored.




### 3.2 Enums (TEXT + CHECK)

`account_kind`, `instrument_status`, `event_meaning`, `pnl_kind`, `claim_direction`, `claim_kind`, `claim_status`, `reservation_status`, `surplus_kind`, `surplus_status`, `surplus_resolution`, `billing_cycle_status`, `obligation_priority`, `instance_status`, `channel`.

### 3.3 What is not a table


| Concept                                               | Persistence                    |
| ----------------------------------------------------- | ------------------------------ |
| Person net, claim open amount, account available, STS | Derived                        |
| CardStatement                                         | Columns on `billing_cycles`    |
| Global reserved pool                                  | `SUM` of reservation remaining |
| Receivable/Payable                                    | `claims.direction`             |
| Payment channel directory                             | CHECK list V1                  |
| Invitation, org, team, workspace switcher             | **None in V1**                 |
| User / membership                                     | `users` + `workspace_memberships` |
| Workspace                                             | Personal per user; plus unowned `Development (legacy)` |




### 3.4 Integrity extras

- Foreign keys enabled in `src/db` connection setup. **SQLite-specific:** `PRAGMA foreign_keys = ON` on each connection (Postgres enforces FKs by default). Keep this in the driver adapter, not in migrations as a business trigger.
- No SQLite triggers for conservation, balances, STS, or delayed salary. Those stay in `src/domain` / `src/app`.
- Application CHECK after each write: per-account `reserved remaining + pending surplus <= balance` (balance = opening + sum(account postings)).
- Migrations: Drizzle SQL in `drizzle/`. Never edit applied files. Stick to portable types: `TEXT`, `INTEGER`, `NOT NULL`, `REFERENCES`, `UNIQUE`, simple `CHECK`.

### 3.5 SQLite → PostgreSQL portability

SQLite is **approved for V1**. Do not add Postgres now.

| Allowed in `src/db` | Avoid |
|---|---|
| TEXT UUIDs generated in app | DB autoincrement as public ids |
| INTEGER paise | REAL money |
| TEXT dates/timestamps | SQLite `datetime('now')` defaults in table DDL |
| CHECK enums as TEXT | Vendor enum types required at V1 (Postgres ENUM can wait) |
| App-side JSON parse | JSON1-only queries as source of truth |
| Driver-specific connection pragmas, isolated in `src/db` | Business logic in triggers, views that the domain depends on |

**Unavoidable SQLite-specific (document, isolate):** WAL mode; `PRAGMA foreign_keys`; `better-sqlite3` synchronous transactions. Wrap transactions behind `src/db/tx.ts` so a future `node-postgres` adapter can use `BEGIN`/`COMMIT` without changing commands.

Boolean columns stored as `INTEGER` 0/1 in SQLite are mapped to `boolean` in loaders. Domain never sees 0/1 flags.

---



## 4. Transaction atomicity

Use `src/db/tx.ts` around each command. V1 implementation may call `better-sqlite3` `db.transaction(() => { ... })()` inside that helper. No nested async I/O inside the callback.


| Command                                                                   | Atomic unit                                                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Split / card spend / expense / lend / borrow / transfer / income / refund | event + shares + postings + claims (if any) + billing cycle create/assign                                     |
| Opening apply                                                             | opening row + seeded claim and/or cycle + optional opening postings                                           |
| Settlement in/out                                                         | event + postings + allocations + claim status updates + reservation(+ledger) and/or surplus                   |
| Pay card                                                                  | event + postings + reservation consume/release + ledger + surplus if excess + cycle funding_cycle already set |
| Pay obligation / EMI                                                      | event + postings + instance `paid_event_id` / status + loan posting                                           |
| Surplus resolve                                                           | resolution event + postings/claims/reservation ledger as required + surplus status                            |
| Salary / income (salary)                                                  | event + postings + funding_cycle `actual_*` + previous cycle implicit close (derived)                         |
| Config change                                                             | insert `config_versions` / `income_policies` only (no event rewrite)                                          |


**Rule:** `persistBatch(workspaceId, batch)` is the only writer of money rows. Commands build a `ProposedBatch` with **no** workspace field; the transaction stamps `workspace_id` on every row. All-or-nothing.

Cycle **generation** (ensure cycle exists for a purchase date) happens in the same transaction as the spend: SELECT FOR uniqueness, INSERT if missing.

Do not commit then “finish reservations” in a second request.

---



## 5. Domain command API

All mutating commands: `preview | commit` flag. Preview runs domain + conservation, no persist. UI uses preview for consequence copy.

Shared types: `IsoDate`, `Paise`, `ConsequencePreview` (Stage 4 contract).


| Command                   | Input (essentials)                                       | Validate                                                                        | Writes                                                       | Output                    |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------- |
| `recordExpense`           | date, paise, accountId, categoryId, channel?, merchant?  | available(account); conservation spend_account                                  | event, postings                                              | preview, eventId          |
| `recordCardSpend`         | date, paise, cardId, categoryId, owner: user | personId  | cycle assign; owner default from card config as-of date snapshotted into shares | event, shares, postings, claim?, cycle                       | preview, eventId, cycleId |
| `recordSplit`             | date, paise, source (account|card), shares[], categoryId | shares sum = total; user share explicit                                         | event, shares, postings, claims, cycle?                      | preview, eventId          |
| `lendMoney`               | date, paise, accountId, personId                         | available                                                                       | event, postings, claim                                       | preview                   |
| `borrowMoney`             | date, paise, accountId, personId                         | —                                                                               | event, postings, claim                                       | preview                   |
| `receiveSettlement`       | date, paise, accountId, personId, allocations[]          | allocations ≤ open; user confirmed; sum vs amount → surplus                     | event, postings, allocations, claims, reservations, surplus? | preview                   |
| `paySettlement`           | date, paise, accountId, personId, allocations[]          | available; payable claims                                                       | event, postings, allocations                                 | preview                   |
| `transferMoney`           | date, paise, fromId, toId                                | from ≠ to; available(from); not reserved                                        | event, postings                                              | preview                   |
| `recordIncome`            | date, paise, accountId, kind salary|other                | if salary: funding cycle for that month                                         | event, postings, funding_cycle actuals                       | preview                   |
| `payCard`                 | date, paise, accountId, cardId, cycleAllocations[]       | available+reserved rules; user confirm if many cycles                           | event, postings, reservation ledger, surplus?                | preview                   |
| `recordObligationPayment` | date, paise, accountId, instanceId                       | available; amount                                                               | event, postings, instance paid                               | preview                   |
| `recordRefund`            | date, originalEventId, paise                             | ≤ original user share                                                           | event (reversal link), postings                              | preview                   |
| `applyOpening`            | opening payload                                          | Zod; card identity check                                                        | opening + seeds                                              | preview                   |
| `resolveSurplus`          | surplusId, resolution, extras                            | pending only                                                                    | event + mutations                                            | preview                   |
| `upsertConfig`            | key, subjectId, effectiveFrom, value                     | no overlap; effectiveFrom policy                                                | config_versions only                                         | ok                        |
| `evaluateSafeToSpend`     | asOf                                                     | —                                                                               | **none**                                                     | snapshot DTO              |
| `simulateAffordability`   | asOf, proposal                                           | proposal Zod                                                                    | **none**                                                     | AffordabilityResult       |


Suggestion of settlement allocations is a **pure** `suggestAllocations(claims, amount)` used by UI; persist only confirmed arrays.

Shopping/receipts (not implemented yet; `docs/06-shopping-receipts-amendment.md`): planning commands mutate session/cart/draft only. Confirm checkout calls existing `recordExpense` / `recordCardSpend` / `recordSplit` with **one** event and category expense postings that sum to the receipt total, plus receipt rows. Cart affordability uses `simulateAffordability` unchanged.

---



## 6. Read-model strategy

**Default: derive on read.** One user, SQLite, WAL: Home/STS is a few thousand rows for a long time.


| Screen                     | Query approach                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Home STS / reserved / have | `loadSnapshot(workspaceId, asOf)` → `evaluateSafeToSpend(snapshot, asOf)` |
| Coming up (3–5 and full)   | UNION instances open + cycles remaining, filter by due, attach reserved sums, run inclusion flags from domain helper (pure) |
| Monthly personal spend     | `SUM(postings.amount)` where `pnl = expense` and `occurred_on` in month                                                     |
| People summary             | `claims` grouped; open amount via allocations subquery                                                                      |
| Activity                   | `financial_events` by `occurred_on DESC` + join meaning/account/card; flags from existence of reservation/shares            |
| Person detail              | claims + allocations + events for person_id                                                                                 |
| Money                      | accounts + sum postings; cards + cycle remaining; reservation sum by account                                                |
| Card cycle                 | cycle row + postings + shares + claims + reservations                                                                       |
| Month review               | expense postings by category for calendar month; exclude via pnl (already expense-only)                                     |


**Do not cache STS.** Recompute. If later slow: memoize snapshot per request, not a table.

**Optional later:** `account_balances` cache table updated in the same write transaction. Not V1.

Funding cycle **status** derived in domain from `asOf` (see §3.1). Coming-up “uncertain / delayed” flags computed with the same functions as STS so Home and Coming up cannot disagree.

---



## 7. STS / simulation implementation structure

```
src/domain/engine/types.ts          LedgerSnapshot, ObligationImpact, …
src/domain/engine/inclusion.ts      q1Include(item, asOf, cycles)  // locked rules
src/domain/engine/liquidity.ts      per-account available
src/domain/engine/evaluateSafeToSpend.ts
src/domain/engine/simulateAffordability.ts
src/domain/engine/projectCycle.ts
```

`evaluateSafeToSpend(snapshot, asOf)`: **pure**, deterministic, no Date.now() except if `asOf` omitted (API always passes `asOf` from `todayKolkata()` at the edge). `LedgerSnapshot` has no `workspaceId` or user fields.

`simulateAffordability(snapshot, asOf, proposal)`: clone snapshot → apply `commands.recordExpense` or `recordCardSpend` in memory → `evaluateSafeToSpend` + `projectCycle` over horizon → result. **Zero I/O.**

Tests feed hand-built snapshots (scenarios A–P) with **no SQLite**. Integration tests load DB → snapshot → same engine, expect equal results.

Explanation items built inside evaluate, not in React.

---



## 8. Date / time strategy

Zone: `Asia/Kolkata` (`Temporal` polyfill or `luxon`/`date-fns-tz` — pick **one**. Recommendation: `luxon` for now; revisit Temporal when stable in Node 22 without extra risk.)


| Value                                                                                                                                          | Store as                 | Rule                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| occurred_on, due_on, statement dates, window start/end, opening effective_on, config effective_from, reservation created_on, actual_arrival_on | `DATE` TEXT `YYYY-MM-DD` | Civil date in Kolkata. Never convert via UTC midnight.               |
| captured_at, created_at, expires_at, resolved_at                                                                                               | UTC timestamp TEXT       | Audit only                                                           |
| “Today”                                                                                                                                        | derived                  | `DateTime.now().setZone('Asia/Kolkata').toISODate()` at API boundary |
| Month review August                                                                                                                            | derived                  | `occurred_on` prefix `YYYY-MM`                                       |
| Billing window                                                                                                                                 | DATE pair                | Inclusive/exclusive as Stage 4; implement once in `cycleAssign`      |


Forbid `new Date('2026-09-08')` (UTC parse). Helper `IsoDate` branded string. Tests freeze `asOf`, never wall clock.

Salary window days 4–8: construct dates as `${year}-${month}-${day}` in Kolkata calendar (handle short months if a future window day exceeds month length — clamp or reject in config validation).

---



## 9. Auth & security (Firebase adapter, workspace isolation)

Firebase Authentication is the **identity adapter**. SQLite remains the financial database. Do not put `firebase_uid`, email, or userId on `LedgerSnapshot`, events, postings, STS, or affordability.

```
Firebase client (Google or email/password)
  → Firebase ID token
  → Authorization: Bearer
  → Hono requireFirebaseAuth
  → Admin SDK verifyIdToken(token, true)
  → firebase uid
  → internal User (provisioned on first request)
  → WorkspaceMembership
  → WorkspaceContext { workspaceId }
  → financial read/write
```

Never trust client-provided uid, email, or workspaceId.

Keep auth in `src/api/auth` plus `src/app/provisionUser.ts` / `src/app/ownership.ts`:

- Public web config: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` (and optional sender/bucket).
- Server: `FIREBASE_PROJECT_ID` plus Admin credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `FIREBASE_SERVICE_ACCOUNT_JSON`, or `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`). Never commit the service account.
- All `/api/*` require a valid Firebase ID token. Missing/invalid/revoked/Firebase-disabled → 401 (`verifyIdToken(token, true)`). Internal `users.status=disabled` → 403. Responses do not expose Auth error codes.
- First login provisioning is transactional and idempotent. Same `firebase_uid` never yields a second internal user or a second personal workspace.
- Do not merge accounts by email. Separate Firebase identities stay separate users.
- Helmet-like headers, JSON body size limit.
- SQLite file outside web root (`../data/app.sqlite`), mode 600.
- Secrets only in env. Never commit `.env`.
- CORS: same-origin only (UI and API same host in production; Vite proxies `/api` locally).

**Local Firebase Console (required to sign in on localhost, not required for `pnpm test`):**

1. Open project `thevishwakarmafinanceapp`.
2. Enable **Google** and **Email/Password** providers.
3. Authorized domains: include `localhost`.
4. Copy the web app config into `.env` as `VITE_FIREBASE_*`.
5. Create a service-account key for Admin SDK and point `GOOGLE_APPLICATION_CREDENTIALS` (or the other Admin env vars) at it. Do not commit the JSON.

Phone OTP, family workspaces, invitations, and workspace switching are not in this stage.

**Not V1:** phone OTP, magic links, org/team UI, per-row RLS.

---



## 10. Test strategy

Priority: **domain unit tests >> SQLite integration >> Playwright**.

### Unit (`tests/domain`) — no DB

Map Stage 4 A–P to fixtures:


| Test file                 | Scenarios                                                                |
| ------------------------- | ------------------------------------------------------------------------ |
| `conservation.test.ts`    | identities per meaning; salary both-positive valid; transfer not expense |
| `scenario-a-to-c.test.ts` | A salary+expense, B transfer, C personal card                            |
| `scenario-d-to-g.test.ts` | split, early/partial/overpay                                             |
| `scenario-h-i.test.ts`    | loan, mixed settlement                                                   |
| `scenario-j-l.test.ts`    | timelines, delayed not yet, month rollover                               |
| `scenario-k-o.test.ts`    | window, delayed 10 Sep, salary arrives                                   |
| `scenario-m.test.ts`      | config as-of                                                             |
| `scenario-n-p.test.ts`    | Q2 next-cycle tight; Q2 horizon +2                                       |


Also: inclusion matrix, reservation consume vs release vs surplus, suggestAllocations does not persist.

### Integration (`tests/integration`)

Temp file SQLite, run migrations, `commit` commands, assert rows + `evaluateSafeToSpend` matches unit fixture. Must cover: split atomicity (kill mid-batch impossible), settlement+reservation, pay card consume, salary activates cycle, surplus pending blocks available.

### E2E (later)

Login, record expense, Home shows spend, logout. Not a substitute for A–P.

CI: `pnpm test` on Node 22. No cloud DB.

---



## 11. Implementation sequence

Do **not** create every table then every screen. Domain tests can start with in-memory snapshots **before** Drizzle exists.

1. **Foundation** — Paise, IsoDate, Vitest, Hono hello, auth stub, seed **one** workspace, Drizzle accounts+events+postings with `workspace_id`.
2. **Openings + accounts** — applyOpening, Money balances.
3. **Expense + income + Activity** — first vertical slice.
4. **Transfers** including cash.
5. **Categories + Month review thin** (expense sum).
6. **Cards + billing_cycles + recordCardSpend + cycle UI**.
7. **People + splits + claims + Person detail**.
8. **Settlements + reservations + surplus pending**.
9. **IncomePolicy + funding_cycles + salary command + delayed status derivation**.
10. **Obligation templates/instances + Coming up**.
11. **Wire evaluateSafeToSpend to Home** (engine tests already green from step 1–10 fixtures).
12. **simulateAffordability**.
13. **Surplus resolution + payCard consume/release**.
14. **Budgets thin + Home composition + PWA**.
15. Backup (Litestream) when hosted.

Challenge to “STS late”: **write engine tests from step 1** against fake snapshots; **wire Home only when real postings exist** (step 11). Do not postpone the formula code until the UI exists.

Challenge to “all tables first”: steps 1–4 use a subset of §3. Add tables when the slice needs them.

---



## 12. Decisions requiring approval

**T1. SQLite vs Postgres.** **SQLite approved for V1.** Do not introduce Postgres for hypothetical scale. Keep SQL portable (§3.5) so a later migration does not rewrite the domain.

**T2. Where it runs.** (a) Laptop-only + Tailscale, or (b) small hosted VM so the phone works when the laptop is off. Phone-first capture strongly prefers **(b)**. Confirm.

**T3. PWA vs Expo.** Default: **PWA** (browser, add to Home Screen). Expo only if you insist on App Store / offline-on-device SQLite.

**T4. Funding cycle** `status` **column.** Default: **derive in domain**, do not persist status (avoids stale `upcoming` after the 8th).

**T5. Billing cycle** `amount_paid` **/** `expected_amount` **columns.** Default: **derive from postings**.

**T6. Session password vs Tailscale-only.** Default: **password session** even on a private network.

**T7. Date library.** Default: **Luxon** + branded `IsoDate`.

---



## 13. Blockers

**None for writing code after T1–T3 are answered.**

T2 is the only one that changes deploy topology. Architecture of domain/DB/commands stays the same either way.

No framework or app exists today; scaffolding waits for this stage’s approval.

---

## 14. Future public migration

V1 is personal-use. Do not build SaaS now. Preserve a path that does **not** rewrite the financial domain.

**Boundary (locked):**

```
Application (auth + workspaceId)
  → load workspace financial snapshot
  → pure domain engine (no auth, no tenancy)
```

**A future public launch should mainly add:**

1. Real User authentication — **done (Firebase adapter)**
2. User ↔ Workspace membership table — **done (owner-only V1)**
3. Workspace isolation (financial `workspace_id` plus membership + ownership checks)
4. PostgreSQL, if scale requires it (replace `src/db` driver/adapter; same schema shapes)
5. Shared workspaces, invitations, extra roles
6. Onboarding beyond empty Personal books
7. Deployment and observability

**It must not require rewriting:**

- FinancialEvent / Posting / conservation
- Claims, settlements, reservations, surplus
- BillingCycle / FundingCycle logic
- Safe-to-Spend or affordability simulation

**Do not add in V1:** registration, organizations, invitations, subscriptions, roles, public onboarding, multi-user UI, billing, multi-tenant infrastructure.