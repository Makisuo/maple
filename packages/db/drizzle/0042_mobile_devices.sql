CREATE TABLE "mobile_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"token" text NOT NULL,
	"environment" text NOT NULL,
	"bundle_id" text NOT NULL,
	"app_version" text,
	"device_name" text,
	"preferences" jsonb NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"last_pushed_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mobile_devices_org_platform_token_unique" ON "mobile_devices" USING btree ("org_id","platform","token");--> statement-breakpoint
CREATE INDEX "mobile_devices_org_idx" ON "mobile_devices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "mobile_devices_user_idx" ON "mobile_devices" USING btree ("user_id");