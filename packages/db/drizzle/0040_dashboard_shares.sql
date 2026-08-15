-- Share links for dashboards: one live row per dashboard (partial unique index
-- below), "public" = anyone with the link, "org" = signed-in members of org_id.
--
-- The foreign key is a deliberate exception to this schema's no-FK convention.
-- Elsewhere a dangling row is cosmetic; here it is a security bug — a deleted
-- dashboard whose share row survives is a link that still resolves.
CREATE TABLE "dashboard_shares" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"dashboard_id" text NOT NULL,
	"mode" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_suffix" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "dashboard_shares_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "dashboard_shares" ADD CONSTRAINT "dashboard_shares_dashboard_fk" FOREIGN KEY ("org_id","dashboard_id") REFERENCES "public"."dashboards"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_shares_token_hash_unq" ON "dashboard_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_shares_live_unq" ON "dashboard_shares" USING btree ("org_id","dashboard_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "dashboard_shares_org_dashboard_idx" ON "dashboard_shares" USING btree ("org_id","dashboard_id");