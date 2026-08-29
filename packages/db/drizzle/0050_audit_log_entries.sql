CREATE TABLE "audit_log_entries" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"actor_type" text NOT NULL,
	"user_id" text,
	"api_key_id" text,
	"actor_id" text,
	"actor_label" text,
	"affected_user_id" text,
	"source" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"denial_reason" text,
	"resource_type" text,
	"resource_id" text,
	"changed_fields" text[],
	"changes_json" jsonb,
	"metadata_json" jsonb,
	"request_id" text,
	"origin_ip" text,
	"origin_country" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_log_entries_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
CREATE INDEX "audit_log_entries_org_occurred_idx" ON "audit_log_entries" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_entries_org_actor_type_occurred_idx" ON "audit_log_entries" USING btree ("org_id","actor_type","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_entries_org_resource_idx" ON "audit_log_entries" USING btree ("org_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "audit_log_entries_org_request_idx" ON "audit_log_entries" USING btree ("org_id","request_id");--> statement-breakpoint
CREATE INDEX "audit_log_entries_org_outcome_occurred_idx" ON "audit_log_entries" USING btree ("org_id","outcome","occurred_at");