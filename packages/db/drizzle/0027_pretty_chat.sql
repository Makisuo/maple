-- Scheduler claim lock, split out of `alert_rules`.
--
-- The alerting cron CAS-claims every enabled rule once a minute. Holding that claim in
-- `alert_rules.last_scheduled_at` meant a per-minute UPDATE on the widest Electric-synced
-- table, which under REPLICA IDENTITY FULL wrote the entire old row plus the new row into
-- the WAL and shipped both out of PlanetScale to Electric Cloud. This table is NOT added
-- to `electric_publication_default` — Electric runs with ELECTRIC_MANUAL_TABLE_PUBLISHING
-- (see 0009), so a new table stays unpublished unless a migration adds it. Keep it that way.
--
-- No backfill: the first scheduler tick inserts a claim row per rule, and a missing row is
-- exactly the "never claimed" case the INSERT arm of the upsert handles.
CREATE TABLE "alert_rule_claims" (
	"rule_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"last_scheduled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "alert_rule_claims_org_idx" ON "alert_rule_claims" USING btree ("org_id");