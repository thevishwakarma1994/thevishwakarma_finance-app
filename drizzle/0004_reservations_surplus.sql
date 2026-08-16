CREATE TABLE `reservations` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `source_account_id` TEXT NOT NULL,
  `amount_original_paise` INTEGER NOT NULL,
  `amount_consumed_paise` INTEGER NOT NULL DEFAULT 0,
  `amount_released_paise` INTEGER NOT NULL DEFAULT 0,
  `amount_reassigned_paise` INTEGER NOT NULL DEFAULT 0,
  `amount_surplus_held_paise` INTEGER NOT NULL DEFAULT 0,
  `status` TEXT NOT NULL,
  `obligation_ref_type` TEXT NOT NULL,
  `obligation_ref_id` TEXT NOT NULL,
  `originating_event_id` TEXT,
  `originating_claim_id` TEXT,
  `created_on` TEXT NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`source_account_id`) REFERENCES `accounts`(`id`),
  FOREIGN KEY (`originating_event_id`) REFERENCES `financial_events`(`id`),
  FOREIGN KEY (`originating_claim_id`) REFERENCES `claims`(`id`),
  CHECK (
    `amount_original_paise`
    - `amount_consumed_paise`
    - `amount_released_paise`
    - `amount_reassigned_paise`
    - `amount_surplus_held_paise` >= 0
  )
);

CREATE INDEX `reservations_account_status` ON `reservations` (`source_account_id`, `status`);
CREATE INDEX `reservations_obligation` ON `reservations` (`obligation_ref_type`, `obligation_ref_id`);
CREATE INDEX `reservations_workspace` ON `reservations` (`workspace_id`);

CREATE TABLE `reservation_ledger` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `reservation_id` TEXT NOT NULL,
  `event_id` TEXT NOT NULL,
  `delta_consumed_paise` INTEGER NOT NULL DEFAULT 0,
  `delta_released_paise` INTEGER NOT NULL DEFAULT 0,
  `delta_reassigned_paise` INTEGER NOT NULL DEFAULT 0,
  `delta_surplus_held_paise` INTEGER NOT NULL DEFAULT 0,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`),
  FOREIGN KEY (`event_id`) REFERENCES `financial_events`(`id`)
);

CREATE INDEX `reservation_ledger_reservation_created` ON `reservation_ledger` (`reservation_id`, `created_at`);
CREATE INDEX `reservation_ledger_workspace` ON `reservation_ledger` (`workspace_id`);

CREATE TABLE `surplus_cases` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `amount_paise` INTEGER NOT NULL,
  `kind` TEXT NOT NULL,
  `source_account_id` TEXT,
  `person_id` TEXT,
  `reservation_id` TEXT,
  `event_id` TEXT,
  `explanation` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `resolution` TEXT,
  `resolved_at` TEXT,
  `resolved_by_event_id` TEXT,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`source_account_id`) REFERENCES `accounts`(`id`),
  FOREIGN KEY (`person_id`) REFERENCES `people`(`id`),
  FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`),
  FOREIGN KEY (`event_id`) REFERENCES `financial_events`(`id`),
  FOREIGN KEY (`resolved_by_event_id`) REFERENCES `financial_events`(`id`)
);

CREATE INDEX `surplus_cases_status` ON `surplus_cases` (`status`);
CREATE INDEX `surplus_cases_person_status` ON `surplus_cases` (`person_id`, `status`);
CREATE INDEX `surplus_cases_workspace` ON `surplus_cases` (`workspace_id`);

CREATE INDEX `settlement_allocations_reservation` ON `settlement_allocations` (`reservation_id`);
