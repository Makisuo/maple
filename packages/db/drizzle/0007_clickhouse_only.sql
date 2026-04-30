-- Drop self-managed Tinybird support: the BYO-Tinybird workflow is gone, so
-- only ClickHouse-backed BYO rows survive. Existing rows with backend='tinybird'
-- are dropped (those orgs fall back to the default Maple-managed Tinybird).
-- The renamed table also picks up a schema_version column for tracking which
-- snapshot has been applied to the customer's cluster.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE `org_tinybird_sync_runs`;--> statement-breakpoint
CREATE TABLE `org_clickhouse_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`ch_url` text NOT NULL,
	`ch_user` text NOT NULL,
	`ch_password_ciphertext` text,
	`ch_password_iv` text,
	`ch_password_tag` text,
	`ch_database` text NOT NULL,
	`sync_status` text NOT NULL,
	`last_sync_at` integer,
	`last_sync_error` text,
	`schema_version` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL
);--> statement-breakpoint
INSERT INTO `org_clickhouse_settings` (
	`org_id`, `ch_url`, `ch_user`, `ch_password_ciphertext`, `ch_password_iv`, `ch_password_tag`,
	`ch_database`, `sync_status`, `last_sync_at`, `last_sync_error`, `schema_version`,
	`created_at`, `updated_at`, `created_by`, `updated_by`
)
SELECT
	`org_id`, `ch_url`, `ch_user`, `ch_password_ciphertext`, `ch_password_iv`, `ch_password_tag`,
	`ch_database`,
	CASE WHEN `sync_status` = 'active' THEN 'connected' ELSE 'error' END,
	`last_sync_at`,
	`last_sync_error`,
	NULL,
	`created_at`, `updated_at`, `created_by`, `updated_by`
FROM `org_tinybird_settings`
WHERE `backend` = 'clickhouse'
	AND `ch_url` IS NOT NULL
	AND `ch_user` IS NOT NULL
	AND `ch_database` IS NOT NULL;--> statement-breakpoint
DROP TABLE `org_tinybird_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
