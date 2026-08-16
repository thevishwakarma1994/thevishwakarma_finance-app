CREATE TABLE `obligation_templates` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `name` TEXT NOT NULL,
  `priority` TEXT NOT NULL,
  `due_rule` TEXT NOT NULL,
  `default_account_id` TEXT,
  `loan_id` TEXT,
  `effective_from` TEXT NOT NULL,
  `effective_to` TEXT,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`default_account_id`) REFERENCES `accounts`(`id`)
);

CREATE INDEX `obligation_templates_workspace_from` ON `obligation_templates` (`workspace_id`, `effective_from`, `effective_to`);

CREATE TABLE `obligation_instances` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `template_id` TEXT,
  `name_snapshot` TEXT NOT NULL,
  `due_on` TEXT NOT NULL,
  `amount_paise` INTEGER NOT NULL,
  `priority_snapshot` TEXT NOT NULL,
  `status` TEXT NOT NULL,
  `funding_cycle_id` TEXT,
  `paid_event_id` TEXT,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`template_id`) REFERENCES `obligation_templates`(`id`),
  FOREIGN KEY (`funding_cycle_id`) REFERENCES `funding_cycles`(`id`),
  FOREIGN KEY (`paid_event_id`) REFERENCES `financial_events`(`id`)
);

CREATE UNIQUE INDEX `obligation_instances_template_due` ON `obligation_instances` (`workspace_id`, `template_id`, `due_on`) WHERE `template_id` IS NOT NULL;
CREATE INDEX `obligation_instances_workspace_due_status` ON `obligation_instances` (`workspace_id`, `due_on`, `status`);
CREATE INDEX `obligation_instances_funding_cycle` ON `obligation_instances` (`funding_cycle_id`);

ALTER TABLE `financial_events` ADD COLUMN `obligation_instance_id` TEXT REFERENCES `obligation_instances`(`id`);
CREATE INDEX `events_obligation_instance` ON `financial_events` (`obligation_instance_id`);
