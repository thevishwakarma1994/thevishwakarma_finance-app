-- Fresh PostgreSQL schema for production (Stage 1–14 tables).
-- No live SQLite→Postgres data copy. Apply against an empty database.
-- Dates are TEXT YYYY-MM-DD. Audit timestamps are TEXT ISO-8601 UTC.
-- Money is BIGINT integer paise. Boolean flags remain INTEGER 0/1.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  firebase_uid TEXT NOT NULL,
  display_name TEXT,
  primary_email TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX users_firebase_uid ON users (firebase_uid);
CREATE INDEX users_status ON users (status);

CREATE TABLE workspace_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users (id),
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  role TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX workspace_memberships_user_workspace ON workspace_memberships (user_id, workspace_id);
CREATE INDEX workspace_memberships_workspace ON workspace_memberships (workspace_id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mask TEXT,
  is_primary_salary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX accounts_workspace_kind_status ON accounts (workspace_id, kind, status);

CREATE TABLE categories (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  parent_id TEXT,
  name TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX categories_workspace_parent ON categories (workspace_id, parent_id);

CREATE TABLE credit_cards (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  display_name TEXT NOT NULL,
  issuer TEXT NOT NULL,
  mask TEXT,
  credit_limit_paise BIGINT,
  default_payment_account_id TEXT REFERENCES accounts (id),
  default_owner_person_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX credit_cards_workspace_status ON credit_cards (workspace_id, status);

CREATE TABLE config_versions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  key TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  value TEXT NOT NULL
);

CREATE INDEX config_workspace_key_subject_from ON config_versions (
  workspace_id,
  key,
  subject_id,
  effective_from
);

CREATE TABLE billing_cycles (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  credit_card_id TEXT NOT NULL REFERENCES credit_cards (id),
  purchase_window_start TEXT NOT NULL,
  purchase_window_end TEXT NOT NULL,
  expected_statement_on TEXT NOT NULL,
  actual_statement_on TEXT,
  expected_due_on TEXT NOT NULL,
  actual_due_on TEXT,
  actual_statement_amount_paise BIGINT,
  status TEXT NOT NULL,
  rule_snapshot TEXT NOT NULL
);

CREATE UNIQUE INDEX billing_workspace_card_statement ON billing_cycles (
  workspace_id,
  credit_card_id,
  expected_statement_on
);
CREATE INDEX billing_cycles_workspace_card_status ON billing_cycles (
  workspace_id,
  credit_card_id,
  status
);
CREATE INDEX billing_cycles_expected_due ON billing_cycles (expected_due_on);

CREATE TABLE financial_events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  meaning TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  amount_paise BIGINT NOT NULL,
  account_id TEXT REFERENCES accounts (id),
  credit_card_id TEXT REFERENCES credit_cards (id),
  billing_cycle_id TEXT REFERENCES billing_cycles (id),
  obligation_instance_id TEXT,
  category_id TEXT REFERENCES categories (id),
  channel TEXT,
  merchant TEXT,
  notes TEXT,
  reversal_of_event_id TEXT
);

CREATE INDEX events_workspace_occurred ON financial_events (workspace_id, occurred_on);
CREATE INDEX events_workspace_meaning_occurred ON financial_events (workspace_id, meaning, occurred_on);
CREATE INDEX events_card_cycle ON financial_events (credit_card_id, billing_cycle_id);

CREATE TABLE postings (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  event_id TEXT NOT NULL REFERENCES financial_events (id),
  amount_paise BIGINT NOT NULL,
  account_id TEXT REFERENCES accounts (id),
  credit_card_id TEXT REFERENCES credit_cards (id),
  pnl TEXT,
  category_id TEXT REFERENCES categories (id),
  billing_cycle_id TEXT REFERENCES billing_cycles (id),
  claim_id TEXT
);

CREATE INDEX postings_event ON postings (event_id);
CREATE INDEX postings_account ON postings (account_id);
CREATE INDEX postings_pnl_category ON postings (pnl, category_id);
CREATE INDEX postings_card_cycle ON postings (credit_card_id, billing_cycle_id);

CREATE TABLE opening_positions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  effective_on TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX opening_workspace_kind_subject ON opening_positions (workspace_id, kind, subject_id);

CREATE TABLE people (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  name TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX people_workspace_status ON people (workspace_id, status);

ALTER TABLE credit_cards
  ADD CONSTRAINT credit_cards_default_owner_person_id_fkey
  FOREIGN KEY (default_owner_person_id) REFERENCES people (id);

CREATE TABLE claims (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  person_id TEXT NOT NULL REFERENCES people (id),
  direction TEXT NOT NULL,
  kind TEXT NOT NULL,
  original_amount_paise BIGINT NOT NULL,
  originating_event_id TEXT REFERENCES financial_events (id),
  opening_position_id TEXT REFERENCES opening_positions (id),
  billing_cycle_id TEXT REFERENCES billing_cycles (id),
  obligation_ref_type TEXT,
  obligation_ref_id TEXT,
  note TEXT,
  status TEXT NOT NULL
);

CREATE INDEX claims_person_status ON claims (person_id, status);
CREATE INDEX claims_billing_cycle ON claims (billing_cycle_id);
CREATE INDEX claims_originating_event ON claims (originating_event_id);
CREATE INDEX claims_workspace ON claims (workspace_id);

ALTER TABLE postings
  ADD CONSTRAINT postings_claim_id_fkey
  FOREIGN KEY (claim_id) REFERENCES claims (id);
CREATE INDEX postings_claim ON postings (claim_id);

CREATE TABLE event_shares (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  event_id TEXT NOT NULL REFERENCES financial_events (id),
  person_id TEXT REFERENCES people (id),
  amount_paise BIGINT NOT NULL,
  is_user INTEGER NOT NULL
);

CREATE INDEX event_shares_event ON event_shares (event_id);

CREATE TABLE settlement_allocations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  event_id TEXT NOT NULL REFERENCES financial_events (id),
  claim_id TEXT NOT NULL REFERENCES claims (id),
  amount_paise BIGINT NOT NULL,
  creates_reservation INTEGER NOT NULL,
  reservation_id TEXT
);

CREATE UNIQUE INDEX settlement_event_claim ON settlement_allocations (event_id, claim_id);
CREATE INDEX settlement_allocations_claim ON settlement_allocations (claim_id);
CREATE INDEX settlement_allocations_workspace ON settlement_allocations (workspace_id);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  source_account_id TEXT NOT NULL REFERENCES accounts (id),
  amount_original_paise BIGINT NOT NULL,
  amount_consumed_paise BIGINT NOT NULL DEFAULT 0,
  amount_released_paise BIGINT NOT NULL DEFAULT 0,
  amount_reassigned_paise BIGINT NOT NULL DEFAULT 0,
  amount_surplus_held_paise BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  obligation_ref_type TEXT NOT NULL,
  obligation_ref_id TEXT NOT NULL,
  originating_event_id TEXT REFERENCES financial_events (id),
  originating_claim_id TEXT REFERENCES claims (id),
  created_on TEXT NOT NULL,
  CHECK (
    amount_original_paise
    - amount_consumed_paise
    - amount_released_paise
    - amount_reassigned_paise
    - amount_surplus_held_paise >= 0
  )
);

CREATE INDEX reservations_account_status ON reservations (source_account_id, status);
CREATE INDEX reservations_obligation ON reservations (obligation_ref_type, obligation_ref_id);
CREATE INDEX reservations_workspace ON reservations (workspace_id);

CREATE INDEX settlement_allocations_reservation ON settlement_allocations (reservation_id);

CREATE TABLE reservation_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  reservation_id TEXT NOT NULL REFERENCES reservations (id),
  event_id TEXT NOT NULL REFERENCES financial_events (id),
  delta_consumed_paise BIGINT NOT NULL DEFAULT 0,
  delta_released_paise BIGINT NOT NULL DEFAULT 0,
  delta_reassigned_paise BIGINT NOT NULL DEFAULT 0,
  delta_surplus_held_paise BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX reservation_ledger_reservation_created ON reservation_ledger (reservation_id, created_at);
CREATE INDEX reservation_ledger_workspace ON reservation_ledger (workspace_id);

CREATE TABLE surplus_cases (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  amount_paise BIGINT NOT NULL,
  kind TEXT NOT NULL,
  source_account_id TEXT REFERENCES accounts (id),
  person_id TEXT REFERENCES people (id),
  reservation_id TEXT REFERENCES reservations (id),
  event_id TEXT REFERENCES financial_events (id),
  explanation TEXT NOT NULL,
  status TEXT NOT NULL,
  resolution TEXT,
  resolved_at TEXT,
  resolved_by_event_id TEXT REFERENCES financial_events (id)
);

CREATE INDEX surplus_cases_status ON surplus_cases (status);
CREATE INDEX surplus_cases_person_status ON surplus_cases (person_id, status);
CREATE INDEX surplus_cases_workspace ON surplus_cases (workspace_id);

CREATE TABLE income_policies (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  expected_amount_paise BIGINT NOT NULL,
  window_start_day INTEGER NOT NULL,
  window_end_day INTEGER NOT NULL,
  typical_day INTEGER,
  effective_from TEXT NOT NULL,
  effective_to TEXT
);

CREATE INDEX income_policies_workspace_from ON income_policies (workspace_id, effective_from);

CREATE TABLE funding_cycles (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  expected_window_start TEXT NOT NULL,
  expected_window_end TEXT NOT NULL,
  expected_amount_snapshot BIGINT NOT NULL,
  actual_arrival_on TEXT,
  actual_amount_paise BIGINT,
  salary_event_id TEXT REFERENCES financial_events (id)
);

CREATE UNIQUE INDEX funding_cycles_workspace_year_month ON funding_cycles (workspace_id, year, month);
CREATE INDEX funding_cycles_workspace_window ON funding_cycles (workspace_id, expected_window_start);

CREATE TABLE obligation_templates (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  name TEXT NOT NULL,
  priority TEXT NOT NULL,
  due_rule TEXT NOT NULL,
  default_account_id TEXT REFERENCES accounts (id),
  loan_id TEXT,
  effective_from TEXT NOT NULL,
  effective_to TEXT
);

CREATE INDEX obligation_templates_workspace_from ON obligation_templates (workspace_id, effective_from, effective_to);

CREATE TABLE obligation_instances (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces (id),
  template_id TEXT REFERENCES obligation_templates (id),
  name_snapshot TEXT NOT NULL,
  due_on TEXT NOT NULL,
  amount_paise BIGINT NOT NULL,
  priority_snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  funding_cycle_id TEXT REFERENCES funding_cycles (id),
  paid_event_id TEXT REFERENCES financial_events (id)
);

CREATE UNIQUE INDEX obligation_instances_template_due
  ON obligation_instances (workspace_id, template_id, due_on)
  WHERE template_id IS NOT NULL;
CREATE INDEX obligation_instances_workspace_due_status ON obligation_instances (workspace_id, due_on, status);
CREATE INDEX obligation_instances_funding_cycle ON obligation_instances (funding_cycle_id);

ALTER TABLE financial_events
  ADD CONSTRAINT financial_events_obligation_instance_id_fkey
  FOREIGN KEY (obligation_instance_id) REFERENCES obligation_instances (id);
CREATE INDEX events_obligation_instance ON financial_events (obligation_instance_id);
