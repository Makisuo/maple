-- IF NOT EXISTS is deliberate and load-bearing, not drizzle-generated.
--
-- This file is the squash of the original 0023_stormy_gorgon +
-- 0024_redundant_grandmaster (commit 8895402f9). That squash assumed no durable
-- environment had applied the old pair — but prod had, so prod's ledger holds
-- the two pre-squash hashes while this file's own hash is absent. drizzle gates
-- on `created_at` vs the journal's `when` and never compares hashes
-- (pg-core/dialect.js), and this file's `when` is newer than the last recorded
-- migration, so it re-runs and dies on 42P07 "relation already exists" — taking
-- every later migration with it, since they all share one transaction.
--
-- Prod's live slack_workspaces already matches this definition exactly (18
-- columns, same types/nullability, all three indexes), so skipping is a true
-- no-op and hides no drift. Guarding here also self-heals local dev databases
-- left in the same pre-squash state.
CREATE TABLE IF NOT EXISTS "slack_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text,
	"bot_user_id" text,
	"scope" text,
	"bot_token_ciphertext" text,
	"bot_token_iv" text,
	"bot_token_tag" text,
	"api_key_id" text,
	"api_key_secret_ciphertext" text,
	"api_key_secret_iv" text,
	"api_key_secret_tag" text,
	"installed_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slack_workspaces_team_id_idx" ON "slack_workspaces" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "slack_workspaces_org_idx" ON "slack_workspaces" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slack_workspaces_active_org_idx" ON "slack_workspaces" USING btree ("org_id") WHERE "slack_workspaces"."revoked_at" IS NULL;