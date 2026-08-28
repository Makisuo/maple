DROP INDEX "cf_analytics_state_org_dataset_zone_idx";--> statement-breakpoint
DROP INDEX "oauth_connections_org_provider_idx";--> statement-breakpoint
ALTER TABLE "cloudflare_analytics_state" ADD COLUMN "account_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "cloudflare_hyperdrive_configs" ADD COLUMN "account_id" text;--> statement-breakpoint
-- Backfill the new account dimension from the org's (single, pre-multi-account) Cloudflare
-- connection. Runs before the unique index lands; rows of orgs with no connection keep ''.
UPDATE "cloudflare_analytics_state" SET "account_id" = c."external_user_id" FROM "oauth_connections" c WHERE c."org_id" = "cloudflare_analytics_state"."org_id" AND c."provider" = 'cloudflare';--> statement-breakpoint
UPDATE "cloudflare_hyperdrive_configs" SET "account_id" = c."external_user_id" FROM "oauth_connections" c WHERE c."org_id" = "cloudflare_hyperdrive_configs"."org_id" AND c."provider" = 'cloudflare';--> statement-breakpoint
CREATE UNIQUE INDEX "cf_analytics_state_org_account_dataset_zone_idx" ON "cloudflare_analytics_state" USING btree ("org_id","account_id","dataset","zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_connections_org_provider_account_idx" ON "oauth_connections" USING btree ("org_id","provider","external_user_id");
