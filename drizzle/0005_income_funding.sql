CREATE TABLE `income_policies` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `expected_amount_paise` INTEGER NOT NULL,
  `window_start_day` INTEGER NOT NULL,
  `window_end_day` INTEGER NOT NULL,
  `typical_day` INTEGER,
  `effective_from` TEXT NOT NULL,
  `effective_to` TEXT,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);

CREATE INDEX `income_policies_workspace_from` ON `income_policies` (`workspace_id`, `effective_from`);

CREATE TABLE `funding_cycles` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `year` INTEGER NOT NULL,
  `month` INTEGER NOT NULL,
  `expected_window_start` TEXT NOT NULL,
  `expected_window_end` TEXT NOT NULL,
  `expected_amount_snapshot` INTEGER NOT NULL,
  `actual_arrival_on` TEXT,
  `actual_amount_paise` INTEGER,
  `salary_event_id` TEXT,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`salary_event_id`) REFERENCES `financial_events`(`id`)
);

CREATE UNIQUE INDEX `funding_cycles_workspace_year_month` ON `funding_cycles` (`workspace_id`, `year`, `month`);
CREATE INDEX `funding_cycles_workspace_window` ON `funding_cycles` (`workspace_id`, `expected_window_start`);
