CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`content_json` text NOT NULL,
	`content_text` text NOT NULL,
	`project_id` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`is_indexed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `notes_user_id_idx` ON `notes` (`user_id`);