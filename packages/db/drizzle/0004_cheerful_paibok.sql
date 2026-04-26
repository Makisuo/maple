CREATE TABLE `dashboard_versions` (
	`org_id` text NOT NULL,
	`id` text NOT NULL,
	`dashboard_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`change_kind` text NOT NULL,
	`change_summary` text,
	`source_version_id` text,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	PRIMARY KEY(`org_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `dashboard_versions_org_dashboard_idx` ON `dashboard_versions` (`org_id`,`dashboard_id`,`version_number`);