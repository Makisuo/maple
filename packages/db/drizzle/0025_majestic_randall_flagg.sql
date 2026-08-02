CREATE TABLE "org_spend_limits" (
	"org_id" text PRIMARY KEY NOT NULL,
	"monthly_limit_cents" integer,
	"enforcement_mode" text DEFAULT 'notify' NOT NULL,
	"alert_threshold_percents" jsonb DEFAULT '[80,100]'::jsonb NOT NULL,
	"feature_caps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_evaluated_at" timestamp with time zone,
	"evaluated_spend_cents" integer,
	"breached_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notified_thresholds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cycle_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
