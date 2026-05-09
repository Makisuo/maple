ALTER TABLE `dashboards` ADD `version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `dashboard_versions_org_dashboard_version_unq` ON `dashboard_versions` (`org_id`,`dashboard_id`,`version_number`);
