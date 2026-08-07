-- Hand-edited to `IF NOT EXISTS`, which `drizzle-kit generate` does not emit.
--
-- A first run of this migration half-applied against the `main` branch: several
-- of these columns were created, then it failed, and because the row is only
-- written to `drizzle.__drizzle_migrations` after the whole file succeeds, every
-- retry replayed from the top and died on `42701 duplicate_column`. That is not
-- recoverable by re-running, and the alternative fixes both require somebody to
-- hand-write production state — dropping the orphaned columns, or inserting the
-- migrations row directly.
--
-- Idempotent DDL is the version that heals every branch by itself: `main`, `stg`
-- and any PR branch can each be at a different point in this file and still
-- converge on one re-run. Adding a column is the one DDL where Postgres gives us
-- this for free.
--
-- Do NOT take this as a house style. `IF NOT EXISTS` on a migration that is
-- meant to fail loudly — a rename, a type change, anything with a data
-- component — hides a real divergence instead of surfacing it. It belongs here
-- because every statement below is a pure additive column on a table whose new
-- columns are all nullable or defaulted, so "already there" and "just created"
-- are genuinely the same end state.
ALTER TABLE "ai_triage_settings" ALTER COLUMN "max_passes_per_day" SET DEFAULT 90;--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD COLUMN IF NOT EXISTS "lens_name" text;--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD COLUMN IF NOT EXISTS "lens_question" text;--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD COLUMN IF NOT EXISTS "priority" integer;--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD COLUMN IF NOT EXISTS "deadline_hit" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD COLUMN IF NOT EXISTS "hypothesis_json" jsonb;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN IF NOT EXISTS "plan_json" jsonb;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN IF NOT EXISTS "planner_model" text;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN IF NOT EXISTS "planner_elapsed_ms" integer;
