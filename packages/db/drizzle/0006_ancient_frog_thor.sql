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
CREATE UNIQUE INDEX `cloudflare_logpush_connectors_secret_hash_unique` ON `cloudflare_logpush_connectors` (`secret_hash`);