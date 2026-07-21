CREATE TABLE "cli_device_authorizations" (
	"device_code_hash" text PRIMARY KEY NOT NULL,
	"user_code_hash" text NOT NULL,
	"device_name" text NOT NULL,
	"approved_org_id" text,
	"approved_user_id" text,
	"approved_roles" jsonb,
	"approved_user_email" text,
	"api_key_id" text,
	"token_ciphertext" text,
	"token_iv" text,
	"token_tag" text,
	"approved_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cli_device_authorizations_user_code_unique" ON "cli_device_authorizations" USING btree ("user_code_hash");--> statement-breakpoint
CREATE INDEX "cli_device_authorizations_expires_idx" ON "cli_device_authorizations" USING btree ("expires_at");