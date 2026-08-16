CREATE TABLE `people` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `name` TEXT NOT NULL,
  `notes` TEXT,
  `status` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);

CREATE INDEX `people_workspace_status` ON `people` (`workspace_id`, `status`);

CREATE TABLE `claims` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `person_id` TEXT NOT NULL,
  `direction` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `original_amount_paise` INTEGER NOT NULL,
  `originating_event_id` TEXT,
  `opening_position_id` TEXT,
  `billing_cycle_id` TEXT,
  `obligation_ref_type` TEXT,
  `obligation_ref_id` TEXT,
  `note` TEXT,
  `status` TEXT NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`person_id`) REFERENCES `people`(`id`),
  FOREIGN KEY (`originating_event_id`) REFERENCES `financial_events`(`id`),
  FOREIGN KEY (`opening_position_id`) REFERENCES `opening_positions`(`id`),
  FOREIGN KEY (`billing_cycle_id`) REFERENCES `billing_cycles`(`id`)
);

CREATE INDEX `claims_person_status` ON `claims` (`person_id`, `status`);
CREATE INDEX `claims_billing_cycle` ON `claims` (`billing_cycle_id`);
CREATE INDEX `claims_originating_event` ON `claims` (`originating_event_id`);
CREATE INDEX `claims_workspace` ON `claims` (`workspace_id`);

CREATE TABLE `event_shares` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `event_id` TEXT NOT NULL,
  `person_id` TEXT,
  `amount_paise` INTEGER NOT NULL,
  `is_user` INTEGER NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`event_id`) REFERENCES `financial_events`(`id`),
  FOREIGN KEY (`person_id`) REFERENCES `people`(`id`)
);

CREATE INDEX `event_shares_event` ON `event_shares` (`event_id`);

ALTER TABLE `credit_cards` ADD COLUMN `default_owner_person_id` TEXT REFERENCES `people`(`id`);
ALTER TABLE `postings` ADD COLUMN `claim_id` TEXT REFERENCES `claims`(`id`);

CREATE INDEX `postings_claim` ON `postings` (`claim_id`);
