CREATE TABLE `users` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `firebase_uid` TEXT NOT NULL,
  `display_name` TEXT,
  `primary_email` TEXT,
  `status` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  `updated_at` TEXT NOT NULL
);

CREATE UNIQUE INDEX `users_firebase_uid` ON `users` (`firebase_uid`);
CREATE INDEX `users_status` ON `users` (`status`);

CREATE TABLE `workspace_memberships` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `user_id` TEXT NOT NULL,
  `workspace_id` TEXT NOT NULL,
  `role` TEXT NOT NULL,
  `created_at` TEXT NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`)
);

CREATE UNIQUE INDEX `workspace_memberships_user_workspace` ON `workspace_memberships` (`user_id`, `workspace_id`);
CREATE INDEX `workspace_memberships_workspace` ON `workspace_memberships` (`workspace_id`);

UPDATE `workspaces` SET `name` = 'Development (legacy)' WHERE `name` = 'Personal';

DROP TABLE IF EXISTS `sessions`;
