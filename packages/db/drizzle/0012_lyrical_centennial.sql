CREATE TABLE "planetscale_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"ps_organization" text NOT NULL,
	"token_id" text NOT NULL,
	"token_secret_ciphertext" text NOT NULL,
	"token_secret_iv" text NOT NULL,
	"token_secret_tag" text NOT NULL,
	"connected_by_user_id" text NOT NULL,
	"scrape_target_id" text,
	"webhook_secret_ciphertext" text,
	"webhook_secret_iv" text,
	"webhook_secret_tag" text,
	"detected_permissions_json" jsonb,
	"last_inventory_at" timestamp with time zone,
	"last_inventory_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scrape_targets" ADD COLUMN "managed_by" text;--> statement-breakpoint
CREATE UNIQUE INDEX "planetscale_connections_org_idx" ON "planetscale_connections" USING btree ("org_id");