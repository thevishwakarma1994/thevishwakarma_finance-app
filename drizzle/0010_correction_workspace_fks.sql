CREATE UNIQUE INDEX `financial_events_workspace_id` ON `financial_events` (`workspace_id`, `id`);

DROP TABLE IF EXISTS `transaction_corrections`;

CREATE TABLE `transaction_corrections` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `command_id` TEXT NOT NULL,
  `root_event_id` TEXT NOT NULL,
  `target_event_id` TEXT NOT NULL,
  `reversal_event_id` TEXT NOT NULL,
  `replacement_event_id` TEXT NOT NULL,
  `corrected_on` TEXT NOT NULL,
  `captured_at` TEXT NOT NULL,
  `reason` TEXT,
  UNIQUE (`command_id`),
  UNIQUE (`target_event_id`),
  UNIQUE (`reversal_event_id`),
  UNIQUE (`replacement_event_id`),
  CHECK (`root_event_id` != `reversal_event_id`),
  CHECK (`root_event_id` != `replacement_event_id`),
  CHECK (`target_event_id` != `reversal_event_id`),
  CHECK (`target_event_id` != `replacement_event_id`),
  CHECK (`reversal_event_id` != `replacement_event_id`),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`workspace_id`, `root_event_id`) REFERENCES `financial_events` (`workspace_id`, `id`),
  FOREIGN KEY (`workspace_id`, `target_event_id`) REFERENCES `financial_events` (`workspace_id`, `id`),
  FOREIGN KEY (`workspace_id`, `reversal_event_id`) REFERENCES `financial_events` (`workspace_id`, `id`),
  FOREIGN KEY (`workspace_id`, `replacement_event_id`) REFERENCES `financial_events` (`workspace_id`, `id`)
);

CREATE INDEX `transaction_corrections_workspace_root_captured`
  ON `transaction_corrections` (`workspace_id`, `root_event_id`, `captured_at`);
CREATE INDEX `transaction_corrections_workspace_replacement`
  ON `transaction_corrections` (`workspace_id`, `replacement_event_id`);
CREATE INDEX `transaction_corrections_workspace_corrected_on`
  ON `transaction_corrections` (`workspace_id`, `corrected_on`);
