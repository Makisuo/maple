CREATE TABLE "planetscale_databases" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"database_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'mysql' NOT NULL,
	"state" text,
	"region" text,
	"plan" text,
	"branches_json" jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planetscale_poll_state" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"dataset" text NOT NULL,
	"database_id" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"watermark_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "planetscale_databases_org_db_idx" ON "planetscale_databases" USING btree ("org_id","database_id");--> statement-breakpoint
CREATE INDEX "planetscale_databases_org_idx" ON "planetscale_databases" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "planetscale_poll_state_org_dataset_db_idx" ON "planetscale_poll_state" USING btree ("org_id","dataset","database_id");--> statement-breakpoint
CREATE INDEX "planetscale_poll_state_org_idx" ON "planetscale_poll_state" USING btree ("org_id");