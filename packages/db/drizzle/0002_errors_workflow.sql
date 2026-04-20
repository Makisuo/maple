CREATE TABLE `actors` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`type` text NOT NULL,
	`user_id` text,
	`agent_name` text,
	`model` text,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`last_active_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actors_org_user_idx` ON `actors` (`org_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `actors_org_agent_name_idx` ON `actors` (`org_id`,`agent_name`);--> statement-breakpoint
CREATE INDEX `actors_org_type_idx` ON `actors` (`org_id`,`type`);--> statement-breakpoint
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
CREATE TABLE `error_issue_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`actor_id` text,
	`type` text NOT NULL,
	`from_state` text,
	`to_state` text,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `error_issue_events_issue_idx` ON `error_issue_events` (`org_id`,`issue_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `error_issue_events_actor_idx` ON `error_issue_events` (`org_id`,`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `error_issue_events_type_idx` ON `error_issue_events` (`org_id`,`type`,`created_at`);--> statement-breakpoint
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
	`workflow_state` text DEFAULT 'triage' NOT NULL,
	`priority` integer DEFAULT 3 NOT NULL,
	`assigned_actor_id` text,
	`lease_holder_actor_id` text,
	`lease_expires_at` integer,
	`claimed_at` integer,
	`notes` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`occurrence_count` integer DEFAULT 0 NOT NULL,
	`resolved_at` integer,
	`resolved_by_actor_id` text,
	`snooze_until` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `error_issues_org_fp_idx` ON `error_issues` (`org_id`,`fingerprint_hash`);--> statement-breakpoint
CREATE INDEX `error_issues_org_workflow_idx` ON `error_issues` (`org_id`,`workflow_state`);--> statement-breakpoint
CREATE INDEX `error_issues_org_last_seen_idx` ON `error_issues` (`org_id`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `error_issues_org_assignee_idx` ON `error_issues` (`org_id`,`assigned_actor_id`);--> statement-breakpoint
CREATE INDEX `error_issues_lease_expiry_idx` ON `error_issues` (`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `error_notification_policies` (
	`org_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`destination_ids_json` text DEFAULT '[]' NOT NULL,
	`notify_on_first_seen` integer DEFAULT 1 NOT NULL,
	`notify_on_regression` integer DEFAULT 1 NOT NULL,
	`notify_on_resolve` integer DEFAULT 0 NOT NULL,
	`notify_on_transition_in_review` integer DEFAULT 0 NOT NULL,
	`notify_on_transition_done` integer DEFAULT 0 NOT NULL,
	`notify_on_claim` integer DEFAULT 0 NOT NULL,
	`min_occurrence_count` integer DEFAULT 1 NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `api_keys` ADD `metadata_json` text;