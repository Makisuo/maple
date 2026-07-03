CREATE TABLE IF NOT EXISTS "cloudflare_analytics_state" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"dataset" text NOT NULL,
	"zone_id" text DEFAULT '' NOT NULL,
	"zone_name" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"watermark_at" timestamp with time zone,
	"settings_json" text,
	"settings_fetched_at" timestamp with time zone,
	"quantiles_available" boolean DEFAULT true NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cf_analytics_state_org_dataset_zone_idx" ON "cloudflare_analytics_state" USING btree ("org_id","dataset","zone_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cf_analytics_state_org_idx" ON "cloudflare_analytics_state" USING btree ("org_id");