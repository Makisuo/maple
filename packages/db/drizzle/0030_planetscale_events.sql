CREATE TABLE "planetscale_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"database_id" text DEFAULT '' NOT NULL,
	"database_name" text NOT NULL,
	"branch_name" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"event_type" text NOT NULL,
	"state" text,
	"external_id" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"actor_login" text,
	"url" text,
	"payload_json" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "planetscale_events_dedupe_idx" ON "planetscale_events" USING btree ("org_id","database_name","event_type","external_id","occurred_at");--> statement-breakpoint
CREATE INDEX "planetscale_events_org_db_time_idx" ON "planetscale_events" USING btree ("org_id","database_name","occurred_at");--> statement-breakpoint
CREATE INDEX "planetscale_events_org_time_idx" ON "planetscale_events" USING btree ("org_id","occurred_at");