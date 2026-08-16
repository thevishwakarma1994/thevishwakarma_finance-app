CREATE TABLE `workspaces` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `name` TEXT NOT NULL,
  `created_at` TEXT NOT NULL
);

CREATE TABLE `sessions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `token_hash` TEXT NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  `expires_at` TEXT NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  UNIQUE (`token_hash`)
);

CREATE TABLE `accounts` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `display_name` TEXT NOT NULL,
  `mask` TEXT,
  `is_primary_salary` INTEGER NOT NULL DEFAULT 0,
  `status` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);

CREATE INDEX `accounts_workspace_kind_status` ON `accounts` (`workspace_id`, `kind`, `status`);

CREATE TABLE `categories` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `parent_id` TEXT,
  `name` TEXT NOT NULL,
  `archived_at` TEXT,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);

CREATE INDEX `categories_workspace_parent` ON `categories` (`workspace_id`, `parent_id`);

CREATE TABLE `financial_events` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `meaning` TEXT NOT NULL,
  `occurred_on` TEXT NOT NULL,
  `captured_at` TEXT NOT NULL,
  `amount_paise` INTEGER NOT NULL,
  `account_id` TEXT,
  `category_id` TEXT,
  `channel` TEXT,
  `merchant` TEXT,
  `notes` TEXT,
  `reversal_of_event_id` TEXT,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
  FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`)
);

CREATE INDEX `events_workspace_occurred` ON `financial_events` (`workspace_id`, `occurred_on`);
CREATE INDEX `events_workspace_meaning_occurred` ON `financial_events` (`workspace_id`, `meaning`, `occurred_on`);

CREATE TABLE `postings` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `event_id` TEXT NOT NULL,
  `amount_paise` INTEGER NOT NULL,
  `account_id` TEXT,
  `pnl` TEXT,
  `category_id` TEXT,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  FOREIGN KEY (`event_id`) REFERENCES `financial_events`(`id`),
  FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`),
  FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`)
);

CREATE INDEX `postings_event` ON `postings` (`event_id`);
CREATE INDEX `postings_account` ON `postings` (`account_id`);
CREATE INDEX `postings_pnl_category` ON `postings` (`pnl`, `category_id`);

CREATE TABLE `opening_positions` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `effective_on` TEXT NOT NULL,
  `kind` TEXT NOT NULL,
  `subject_id` TEXT NOT NULL,
  `payload` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`),
  UNIQUE (`workspace_id`, `kind`, `subject_id`)
);
