CREATE TABLE "railway_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"token_type" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_tag" text NOT NULL,
	"external_account_name" text,
	"connected_by_user_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_validation_error" text,
	"last_validation_error_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "railway_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"project_id" text NOT NULL,
	"project_name" text,
	"environment_id" text NOT NULL,
	"environment_name" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"logs_enabled" boolean DEFAULT true NOT NULL,
	"metrics_enabled" boolean DEFAULT true NOT NULL,
	"metrics_interval_seconds" integer DEFAULT 300 NOT NULL,
	"services_json" text,
	"services_discovered_at" timestamp with time zone,
	"log_watermark_at" timestamp with time zone,
	"metrics_watermark_at" timestamp with time zone,
	"last_log_at" timestamp with time zone,
	"last_metrics_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "railway_connections_org_idx" ON "railway_connections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "railway_targets_org_project_env_idx" ON "railway_targets" USING btree ("org_id","project_id","environment_id");--> statement-breakpoint
CREATE INDEX "railway_targets_org_idx" ON "railway_targets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "railway_targets_connection_idx" ON "railway_targets" USING btree ("connection_id");