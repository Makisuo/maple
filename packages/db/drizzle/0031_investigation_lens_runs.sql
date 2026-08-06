CREATE TABLE "investigation_lens_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"investigation_id" text NOT NULL,
	"lens_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"verdict" text DEFAULT 'pending' NOT NULL,
	"claim" text,
	"reason" text,
	"progress_note" text,
	"confidence" text,
	"tool_count" integer DEFAULT 0 NOT NULL,
	"elapsed_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"model" text,
	"evidence_json" jsonb,
	"self_doubt" text,
	"suggested_actions_json" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"reported_at" timestamp with time zone,
	"ranked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "fanout_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "fanout_size" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "validator_note" text;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "validator_elapsed_ms" integer;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "fanout_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "workflow_instance_id" text;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "fanout_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD CONSTRAINT "investigation_lens_runs_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_lens_runs_lens_idx" ON "investigation_lens_runs" USING btree ("investigation_id","lens_id");--> statement-breakpoint
CREATE INDEX "investigation_lens_runs_org_inv_idx" ON "investigation_lens_runs" USING btree ("org_id","investigation_id");