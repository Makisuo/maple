CREATE TABLE "live_activities" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"device_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"activity_id" text NOT NULL,
	"push_token" text NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mobile_devices" ADD COLUMN "live_activity_start_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "live_activities_device_incident_unique" ON "live_activities" USING btree ("device_id","incident_id");--> statement-breakpoint
CREATE INDEX "live_activities_incident_idx" ON "live_activities" USING btree ("org_id","incident_id");