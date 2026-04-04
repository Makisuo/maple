CREATE TABLE `digest_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`day_of_week` integer DEFAULT 1 NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`last_sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digest_subscriptions_org_user_idx` ON `digest_subscriptions` (`org_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `digest_subscriptions_org_enabled_idx` ON `digest_subscriptions` (`org_id`,`enabled`);
