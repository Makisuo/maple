CREATE TABLE "error_notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"destination_id" text NOT NULL,
	"delivery_key" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"claimed_by" text,
	"attempted_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_tick_states" (
	"org_id" text PRIMARY KEY NOT NULL,
	"processed_through" timestamp with time zone NOT NULL,
	"bootstrap_completed" boolean DEFAULT false NOT NULL,
	"claim_token" text,
	"claim_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "error_notification_deliveries_due_idx" ON "error_notification_deliveries" USING btree ("status", "scheduled_at", "claim_expires_at");
--> statement-breakpoint
CREATE INDEX "error_notification_deliveries_org_idx" ON "error_notification_deliveries" USING btree ("org_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "error_notification_deliveries_key_destination_idx" ON "error_notification_deliveries" USING btree ("delivery_key", "destination_id");
--> statement-breakpoint
CREATE INDEX "error_tick_states_claim_idx" ON "error_tick_states" USING btree ("claim_expires_at");
