CREATE TABLE `org_tinybird_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`token_ciphertext` text NOT NULL,
	`token_iv` text NOT NULL,
	`token_tag` text NOT NULL,
	`sync_status` text NOT NULL,
	`last_sync_at` integer,
	`last_sync_error` text,
	`project_revision` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL
);
