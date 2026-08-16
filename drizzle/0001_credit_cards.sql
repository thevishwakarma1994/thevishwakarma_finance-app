CREATE TABLE `credit_cards` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `display_name` TEXT NOT NULL,
  `issuer` TEXT NOT NULL,
  `mask` TEXT,
  `credit_limit_paise` INTEGER,
  `default_payment_account_id` TEXT,
  `status` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`default_payment_account_id`) REFERENCES `accounts`(`id`)
);

CREATE INDEX `credit_cards_workspace_status` ON `credit_cards` (`workspace_id`, `status`);

CREATE TABLE `config_versions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `key` TEXT NOT NULL,
  `subject_id` TEXT NOT NULL,
  `effective_from` TEXT NOT NULL,
  `effective_to` TEXT,
  `value` TEXT NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);

CREATE INDEX `config_workspace_key_subject_from` ON `config_versions` (
  `workspace_id`,
  `key`,
  `subject_id`,
  `effective_from`
);

CREATE TABLE `billing_cycles` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `credit_card_id` TEXT NOT NULL,
  `purchase_window_start` TEXT NOT NULL,
  `purchase_window_end` TEXT NOT NULL,
  `expected_statement_on` TEXT NOT NULL,
  `actual_statement_on` TEXT,
  `expected_due_on` TEXT NOT NULL,
  `actual_due_on` TEXT,
  `actual_statement_amount_paise` INTEGER,
  `status` TEXT NOT NULL,
  `rule_snapshot` TEXT NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`credit_card_id`) REFERENCES `credit_cards`(`id`),
  UNIQUE (`workspace_id`, `credit_card_id`, `expected_statement_on`)
);

CREATE INDEX `billing_cycles_workspace_card_status` ON `billing_cycles` (
  `workspace_id`,
  `credit_card_id`,
  `status`
);
CREATE INDEX `billing_cycles_expected_due` ON `billing_cycles` (`expected_due_on`);

ALTER TABLE `financial_events` ADD COLUMN `credit_card_id` TEXT REFERENCES `credit_cards`(`id`);
ALTER TABLE `financial_events` ADD COLUMN `billing_cycle_id` TEXT REFERENCES `billing_cycles`(`id`);
ALTER TABLE `postings` ADD COLUMN `credit_card_id` TEXT REFERENCES `credit_cards`(`id`);
ALTER TABLE `postings` ADD COLUMN `billing_cycle_id` TEXT REFERENCES `billing_cycles`(`id`);

CREATE INDEX `events_card_cycle` ON `financial_events` (`credit_card_id`, `billing_cycle_id`);
CREATE INDEX `postings_card_cycle` ON `postings` (`credit_card_id`, `billing_cycle_id`);
