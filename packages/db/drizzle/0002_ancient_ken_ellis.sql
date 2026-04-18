CREATE TABLE `error_notification_policies` (
	`org_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`destination_ids_json` text DEFAULT '[]' NOT NULL,
	`notify_on_first_seen` integer DEFAULT 1 NOT NULL,
	`notify_on_regression` integer DEFAULT 1 NOT NULL,
	`notify_on_resolve` integer DEFAULT 0 NOT NULL,
	`min_occurrence_count` integer DEFAULT 1 NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
