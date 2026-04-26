CREATE TABLE `oauth_auth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`initiated_by_user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`return_to` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_auth_states_expires_idx` ON `oauth_auth_states` (`expires_at`);--> statement-breakpoint
CREATE TABLE `oauth_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_user_id` text NOT NULL,
	`external_user_email` text,
	`connected_by_user_id` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`access_token_ciphertext` text NOT NULL,
	`access_token_iv` text NOT NULL,
	`access_token_tag` text NOT NULL,
	`refresh_token_ciphertext` text,
	`refresh_token_iv` text,
	`refresh_token_tag` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_connections_org_provider_idx` ON `oauth_connections` (`org_id`,`provider`);--> statement-breakpoint
CREATE INDEX `oauth_connections_org_idx` ON `oauth_connections` (`org_id`);