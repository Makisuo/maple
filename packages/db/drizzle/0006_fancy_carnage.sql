-- Add new ClickHouse-backend columns and the discriminator. Existing rows
-- default to backend='tinybird' so behaviour is unchanged for current orgs.
ALTER TABLE `org_tinybird_settings` ADD COLUMN `backend` text DEFAULT 'tinybird' NOT NULL;--> statement-breakpoint
ALTER TABLE `org_tinybird_settings` ADD COLUMN `ch_url` text;--> statement-breakpoint
ALTER TABLE `org_tinybird_settings` ADD COLUMN `ch_user` text;--> statement-breakpoint
ALTER TABLE `org_tinybird_settings` ADD COLUMN `ch_password_ciphertext` text;--> statement-breakpoint
ALTER TABLE `org_tinybird_settings` ADD COLUMN `ch_password_iv` text;--> statement-breakpoint
ALTER TABLE `org_tinybird_settings` ADD COLUMN `ch_password_tag` text;--> statement-breakpoint
ALTER TABLE `org_tinybird_settings` ADD COLUMN `ch_database` text;--> statement-breakpoint
-- Relax Tinybird-specific columns to nullable so ClickHouse-only rows are
-- representable. SQLite needs the rename-and-copy dance for nullability changes;
-- column ordering matches the new schema so SELECT * is safe.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_org_tinybird_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`backend` text DEFAULT 'tinybird' NOT NULL,
	`host` text,
	`token_ciphertext` text,
	`token_iv` text,
	`token_tag` text,
	`ch_url` text,
	`ch_user` text,
	`ch_password_ciphertext` text,
	`ch_password_iv` text,
	`ch_password_tag` text,
	`ch_database` text,
	`sync_status` text NOT NULL,
	`last_sync_at` integer,
	`last_sync_error` text,
	`project_revision` text NOT NULL,
	`last_deployment_id` text,
	`logs_retention_days` integer,
	`traces_retention_days` integer,
	`metrics_retention_days` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL
);--> statement-breakpoint
INSERT INTO `__new_org_tinybird_settings` SELECT
	`org_id`, `backend`, `host`, `token_ciphertext`, `token_iv`, `token_tag`,
	`ch_url`, `ch_user`, `ch_password_ciphertext`, `ch_password_iv`, `ch_password_tag`, `ch_database`,
	`sync_status`, `last_sync_at`, `last_sync_error`, `project_revision`, `last_deployment_id`,
	`logs_retention_days`, `traces_retention_days`, `metrics_retention_days`,
	`created_at`, `updated_at`, `created_by`, `updated_by`
FROM `org_tinybird_settings`;--> statement-breakpoint
DROP TABLE `org_tinybird_settings`;--> statement-breakpoint
ALTER TABLE `__new_org_tinybird_settings` RENAME TO `org_tinybird_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
