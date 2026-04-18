CREATE TABLE `error_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`first_triggered_at` integer NOT NULL,
	`last_triggered_at` integer NOT NULL,
	`resolved_at` integer,
	`occurrence_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `error_incidents_org_issue_idx` ON `error_incidents` (`org_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `error_incidents_org_status_idx` ON `error_incidents` (`org_id`,`status`);--> statement-breakpoint
CREATE TABLE `error_issue_states` (
	`org_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`last_observed_occurrence_at` integer,
	`last_evaluated_at` integer,
	`open_incident_id` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `issue_id`)
);
--> statement-breakpoint
CREATE INDEX `error_issue_states_org_idx` ON `error_issue_states` (`org_id`);--> statement-breakpoint
CREATE TABLE `error_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`fingerprint_hash` text NOT NULL,
	`service_name` text NOT NULL,
	`exception_type` text NOT NULL,
	`exception_message` text NOT NULL,
	`top_frame` text NOT NULL,
	`status` text NOT NULL,
	`assigned_to` text,
	`notes` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`occurrence_count` integer DEFAULT 0 NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`ignored_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `error_issues_org_fp_idx` ON `error_issues` (`org_id`,`fingerprint_hash`);--> statement-breakpoint
CREATE INDEX `error_issues_org_status_idx` ON `error_issues` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `error_issues_org_last_seen_idx` ON `error_issues` (`org_id`,`last_seen_at`);