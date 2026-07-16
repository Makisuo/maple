CREATE TABLE "cloudflare_hyperdrive_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"config_id" text NOT NULL,
	"name" text NOT NULL,
	"origin_host" text,
	"origin_port" integer,
	"origin_scheme" text NOT NULL,
	"origin_database" text NOT NULL,
	"origin_user" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cloudflare_hyperdrive_configs_org_config_idx" ON "cloudflare_hyperdrive_configs" USING btree ("org_id","config_id");--> statement-breakpoint
CREATE INDEX "cloudflare_hyperdrive_configs_org_idx" ON "cloudflare_hyperdrive_configs" USING btree ("org_id");