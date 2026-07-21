CREATE TABLE "mcp_oauth_authorizations" (
	"request_id_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"code_challenge" text NOT NULL,
	"authorization_code_hash" text,
	"approved_org_id" text,
	"approved_user_id" text,
	"approved_roles" jsonb,
	"approved_user_email" text,
	"approved_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"client_uri" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" text NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"roles" jsonb NOT NULL,
	"user_email" text,
	"access_key_id" text NOT NULL,
	"replaced_by_id" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_authorizations_code_unique" ON "mcp_oauth_authorizations" USING btree ("authorization_code_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_authorizations_expires_idx" ON "mcp_oauth_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_refresh_tokens_hash_unique" ON "mcp_oauth_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_tokens_family_idx" ON "mcp_oauth_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_tokens_expires_idx" ON "mcp_oauth_refresh_tokens" USING btree ("expires_at");