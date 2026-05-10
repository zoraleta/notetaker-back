CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `groups_user_id_idx` ON `groups` (`user_id`);--> statement-breakpoint
ALTER TABLE `notes` ADD `group_id` text;