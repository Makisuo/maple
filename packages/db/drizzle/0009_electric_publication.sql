-- ElectricSQL logical-replication publication.
--
-- Electric tails Postgres via a publication + replication slot and serves the
-- listed tables as HTTP "shapes". We create the publication ourselves (rather
-- than letting Electric CREATE PUBLICATION ... FOR ALL TABLES) because prod runs
-- ELECTRIC_MANUAL_TABLE_PUBLISHING=true: PlanetScale can't reassign table
-- ownership, and Maple's migrations run under ephemeral pscale roles, so Electric
-- must never need to own these tables. Adding a synced table later = a new
-- `ALTER PUBLICATION electric_publication_default ADD TABLE ...` migration.
--
-- REPLICA IDENTITY FULL makes UPDATE/DELETE WAL records carry the full old row,
-- which Electric needs to (a) key deletes on composite-PK tables and (b) emit a
-- delete when a row moves out of a shape's WHERE clause (e.g. an error issue
-- being archived, or an incident resolving). These are low-write control-plane
-- tables, so the extra WAL volume is negligible.
--
-- Wrapped in a DO/EXCEPTION guard so the embedded PGlite test path
-- (readBundledMigrationsSql → single pglite.exec of every *.sql) never aborts if
-- a statement is unsupported there — logical replication is irrelevant to tests.
-- On real Postgres the block runs exactly once (drizzle tracks applied
-- migrations), and swallowing "already exists" keeps it idempotent.
DO $$
BEGIN
	ALTER TABLE "dashboards" REPLICA IDENTITY FULL;
	ALTER TABLE "alert_rules" REPLICA IDENTITY FULL;
	ALTER TABLE "alert_rule_states" REPLICA IDENTITY FULL;
	ALTER TABLE "alert_incidents" REPLICA IDENTITY FULL;
	ALTER TABLE "error_issues" REPLICA IDENTITY FULL;
	ALTER TABLE "actors" REPLICA IDENTITY FULL;
	ALTER TABLE "error_incidents" REPLICA IDENTITY FULL;

	CREATE PUBLICATION electric_publication_default FOR TABLE
		"dashboards",
		"alert_rules",
		"alert_rule_states",
		"alert_incidents",
		"error_issues",
		"actors",
		"error_incidents";
EXCEPTION
	WHEN duplicate_object THEN
		RAISE NOTICE 'electric publication already exists, skipping';
	WHEN OTHERS THEN
		RAISE NOTICE 'electric publication migration skipped: %', SQLERRM;
END $$;
