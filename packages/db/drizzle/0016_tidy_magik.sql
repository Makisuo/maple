CREATE TABLE "cloudflare_observability_destinations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"account_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"dataset" text NOT NULL,
	"url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"scripts_json" text,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cf_observ_dest_org_dataset_idx" ON "cloudflare_observability_destinations" USING btree ("org_id","dataset");--> statement-breakpoint
CREATE UNIQUE INDEX "cf_observ_dest_account_slug_idx" ON "cloudflare_observability_destinations" USING btree ("account_id","slug");--> statement-breakpoint
CREATE INDEX "cf_observ_dest_org_idx" ON "cloudflare_observability_destinations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "cf_observ_dest_account_idx" ON "cloudflare_observability_destinations" USING btree ("account_id");