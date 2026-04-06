CREATE TABLE `org_tinybird_sync_runs` (
	`org_id` text PRIMARY KEY NOT NULL,
	`requested_by` text NOT NULL,
	`target_host` text NOT NULL,
	`target_token_ciphertext` text NOT NULL,
	`target_token_iv` text NOT NULL,
	`target_token_tag` text NOT NULL,
	`target_project_revision` text NOT NULL,
	`run_status` text NOT NULL,
	`phase` text NOT NULL,
	`deployment_id` text,
	`deployment_status` text,
	`error_message` text,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
