ALTER TABLE "ai_triage_settings" ALTER COLUMN "max_passes_per_day" SET DEFAULT 90;--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD COLUMN "lens_name" text;--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD COLUMN "lens_question" text;--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD COLUMN "priority" integer;--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD COLUMN "deadline_hit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD COLUMN "hypothesis_json" jsonb;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "plan_json" jsonb;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "planner_model" text;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "planner_elapsed_ms" integer;