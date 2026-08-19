ALTER TABLE "alert_destinations" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_destinations" ADD COLUMN "last_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_destinations" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_destinations" ADD COLUMN "disabled_reason" text;