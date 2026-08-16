CREATE TABLE `settlement_allocations` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `event_id` TEXT NOT NULL,
  `claim_id` TEXT NOT NULL,
  `amount_paise` INTEGER NOT NULL,
  `creates_reservation` INTEGER NOT NULL,
  `reservation_id` TEXT,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`event_id`) REFERENCES `financial_events`(`id`),
  FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`)
);

CREATE UNIQUE INDEX `settlement_event_claim` ON `settlement_allocations` (`event_id`, `claim_id`);
CREATE INDEX `settlement_allocations_claim` ON `settlement_allocations` (`claim_id`);
CREATE INDEX `settlement_allocations_workspace` ON `settlement_allocations` (`workspace_id`);
