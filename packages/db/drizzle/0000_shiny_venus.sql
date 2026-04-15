CREATE TABLE `alert_delivery_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`incident_id` text,
	`rule_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`delivery_key` text NOT NULL,
	`event_type` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`status` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`claimed_at` integer,
	`claim_expires_at` integer,
	`claimed_by` text,
	`attempted_at` integer,
	`provider_message` text,
	`provider_reference` text,
	`response_code` integer,
	`error_message` text,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alert_delivery_events_org_idx` ON `alert_delivery_events` (`org_id`);--> statement-breakpoint
CREATE INDEX `alert_delivery_events_org_incident_idx` ON `alert_delivery_events` (`org_id`,`incident_id`);--> statement-breakpoint
CREATE INDEX `alert_delivery_events_due_idx` ON `alert_delivery_events` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `alert_delivery_events_claim_idx` ON `alert_delivery_events` (`status`,`claim_expires_at`,`scheduled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `alert_delivery_events_delivery_attempt_idx` ON `alert_delivery_events` (`delivery_key`,`attempt_number`);--> statement-breakpoint
CREATE TABLE `alert_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`config_json` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`secret_iv` text NOT NULL,
	`secret_tag` text NOT NULL,
	`last_tested_at` integer,
	`last_test_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alert_destinations_org_idx` ON `alert_destinations` (`org_id`);--> statement-breakpoint
CREATE INDEX `alert_destinations_org_enabled_idx` ON `alert_destinations` (`org_id`,`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `alert_destinations_org_name_idx` ON `alert_destinations` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `alert_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`incident_key` text NOT NULL,
	`rule_name` text NOT NULL,
	`group_key` text,
	`signal_type` text NOT NULL,
	`severity` text NOT NULL,
	`status` text NOT NULL,
	`comparator` text NOT NULL,
	`threshold` real NOT NULL,
	`first_triggered_at` integer NOT NULL,
	`last_triggered_at` integer NOT NULL,
	`resolved_at` integer,
	`last_observed_value` real,
	`last_sample_count` integer,
	`last_evaluated_at` integer,
	`dedupe_key` text NOT NULL,
	`last_delivered_event_type` text,
	`last_notified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alert_incidents_org_idx` ON `alert_incidents` (`org_id`);--> statement-breakpoint
CREATE INDEX `alert_incidents_org_status_idx` ON `alert_incidents` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `alert_incidents_org_rule_idx` ON `alert_incidents` (`org_id`,`rule_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `alert_incidents_incident_key_idx` ON `alert_incidents` (`incident_key`);--> statement-breakpoint
CREATE TABLE `alert_rule_states` (
	`org_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`group_key` text DEFAULT '__total__' NOT NULL,
	`consecutive_breaches` integer DEFAULT 0 NOT NULL,
	`consecutive_healthy` integer DEFAULT 0 NOT NULL,
	`last_status` text,
	`last_value` real,
	`last_sample_count` integer,
	`last_evaluated_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `rule_id`, `group_key`)
);
--> statement-breakpoint
CREATE INDEX `alert_rule_states_org_idx` ON `alert_rule_states` (`org_id`);--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`severity` text NOT NULL,
	`service_names_json` text,
	`exclude_service_names_json` text,
	`signal_type` text NOT NULL,
	`comparator` text NOT NULL,
	`threshold` real NOT NULL,
	`window_minutes` integer NOT NULL,
	`minimum_sample_count` integer DEFAULT 0 NOT NULL,
	`consecutive_breaches_required` integer DEFAULT 2 NOT NULL,
	`consecutive_healthy_required` integer DEFAULT 2 NOT NULL,
	`renotify_interval_minutes` integer DEFAULT 30 NOT NULL,
	`metric_name` text,
	`metric_type` text,
	`metric_aggregation` text,
	`apdex_threshold_ms` real,
	`query_data_source` text,
	`query_aggregation` text,
	`query_where_clause` text,
	`group_by` text,
	`destination_ids_json` text NOT NULL,
	`query_spec_json` text NOT NULL,
	`reducer` text NOT NULL,
	`sample_count_strategy` text NOT NULL,
	`no_data_behavior` text NOT NULL,
	`last_scheduled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alert_rules_org_idx` ON `alert_rules` (`org_id`);--> statement-breakpoint
CREATE INDEX `alert_rules_org_enabled_idx` ON `alert_rules` (`org_id`,`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `alert_rules_org_name_idx` ON `alert_rules` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`revoked` integer DEFAULT false NOT NULL,
	`revoked_at` integer,
	`last_used_at` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_org_id_idx` ON `api_keys` (`org_id`);--> statement-breakpoint
CREATE TABLE `cloudflare_logpush_connectors` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`zone_name` text NOT NULL,
	`service_name` text NOT NULL,
	`dataset` text DEFAULT 'http_requests' NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`secret_iv` text NOT NULL,
	`secret_tag` text NOT NULL,
	`secret_hash` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_received_at` integer,
	`last_error` text,
	`secret_rotated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cloudflare_logpush_connectors_org_idx` ON `cloudflare_logpush_connectors` (`org_id`);--> statement-breakpoint
CREATE INDEX `cloudflare_logpush_connectors_org_enabled_idx` ON `cloudflare_logpush_connectors` (`org_id`,`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX `cloudflare_logpush_connectors_secret_hash_unique` ON `cloudflare_logpush_connectors` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `dashboards` (
	`org_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`org_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `dashboards_org_updated_idx` ON `dashboards` (`org_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `dashboards_org_name_idx` ON `dashboards` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `digest_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`day_of_week` integer DEFAULT 1 NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`last_sent_at` integer,
	`last_attempted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_subscriptions_org_user_idx` ON `digest_subscriptions` (`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `digest_subscriptions_org_enabled_idx` ON `digest_subscriptions` (`org_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `org_ingest_keys` (
	`org_id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`public_key_hash` text NOT NULL,
	`private_key_ciphertext` text NOT NULL,
	`private_key_iv` text NOT NULL,
	`private_key_tag` text NOT NULL,
	`private_key_hash` text NOT NULL,
	`public_rotated_at` integer NOT NULL,
	`private_rotated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_ingest_keys_public_key_unique` ON `org_ingest_keys` (`public_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `org_ingest_keys_public_key_hash_unique` ON `org_ingest_keys` (`public_key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `org_ingest_keys_private_key_hash_unique` ON `org_ingest_keys` (`private_key_hash`);--> statement-breakpoint
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
	`last_deployment_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `scrape_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`service_name` text,
	`url` text NOT NULL,
	`scrape_interval_seconds` integer DEFAULT 15 NOT NULL,
	`labels_json` text,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`auth_credentials_ciphertext` text,
	`auth_credentials_iv` text,
	`auth_credentials_tag` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_scrape_at` integer,
	`last_scrape_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scrape_targets_org_idx` ON `scrape_targets` (`org_id`);--> statement-breakpoint
CREATE INDEX `scrape_targets_org_enabled_idx` ON `scrape_targets` (`org_id`,`enabled`);