CREATE TABLE "error_fingerprint_candidates" (
	"org_id" text NOT NULL,
	"fingerprint_hash" text NOT NULL,
	"service_name" text NOT NULL,
	"exception_type" text NOT NULL,
	"exception_message" text NOT NULL,
	"error_label" text DEFAULT '' NOT NULL,
	"top_frame" text NOT NULL,
	"service_versions_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "error_fingerprint_candidates_org_id_fingerprint_hash_pk" PRIMARY KEY("org_id","fingerprint_hash")
);
--> statement-breakpoint
ALTER TABLE "error_issues" ADD COLUMN "last_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "error_issues" ADD COLUMN "last_regressed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "error_issues" ADD COLUMN "regression_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "error_issues" ADD COLUMN "seen_versions_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "error_issues" ADD COLUMN "resolved_versions_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "error_fingerprint_candidates_last_seen_idx" ON "error_fingerprint_candidates" USING btree ("org_id","last_seen_at");
