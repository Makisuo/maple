CREATE TABLE "slack_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text,
	"bot_user_id" text,
	"scope" text,
	"bot_token_ciphertext" text NOT NULL,
	"bot_token_iv" text NOT NULL,
	"bot_token_tag" text NOT NULL,
	"api_key_id" text,
	"api_key_secret_ciphertext" text NOT NULL,
	"api_key_secret_iv" text NOT NULL,
	"api_key_secret_tag" text NOT NULL,
	"installed_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "slack_workspaces_team_id_idx" ON "slack_workspaces" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "slack_workspaces_org_idx" ON "slack_workspaces" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_workspaces_active_org_idx" ON "slack_workspaces" USING btree ("org_id") WHERE "slack_workspaces"."revoked_at" IS NULL;