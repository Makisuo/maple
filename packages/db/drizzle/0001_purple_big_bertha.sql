ALTER TABLE `org_tinybird_settings` ADD `logs_retention_days` integer;--> statement-breakpoint
ALTER TABLE `org_tinybird_settings` ADD `traces_retention_days` integer;--> statement-breakpoint
ALTER TABLE `org_tinybird_settings` ADD `metrics_retention_days` integer;--> statement-breakpoint
ALTER TABLE `org_tinybird_sync_runs` ADD `target_logs_retention_days` integer;--> statement-breakpoint
ALTER TABLE `org_tinybird_sync_runs` ADD `target_traces_retention_days` integer;--> statement-breakpoint
ALTER TABLE `org_tinybird_sync_runs` ADD `target_metrics_retention_days` integer;