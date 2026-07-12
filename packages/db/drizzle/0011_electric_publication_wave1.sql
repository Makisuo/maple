-- ElectricSQL sync — Wave 1 tables.
--
-- Adds two control-plane tables to the existing `electric_publication_default`
-- publication + REPLICA IDENTITY FULL so Electric can tail them as HTTP shapes:
--   * alert_destinations   (finishes the alerts settings surface)
--   * scrape_target_checks (uptime-probe history; already 24h/10k-bounded server-side)
--
-- See 0009_electric_publication for the rationale (manual publishing on
-- PlanetScale, and why REPLICA IDENTITY FULL is required — composite-key deletes
-- and WHERE-exit deletes). `alert_destinations` is served column-restricted by the
-- shape proxy (its encrypted `secret_*` columns are never projected to the
-- browser); the publication still carries the full row via REPLICA IDENTITY FULL,
-- and the proxy pins the column projection on the shape request, so the client
-- only ever receives the whitelisted columns.
--
-- Wrapped in the same DO/EXCEPTION guard as 0009 so the embedded PGlite test path
-- (readBundledMigrationsSql → single pglite.exec of every *.sql) never aborts on
-- an unsupported statement. On real Postgres it runs exactly once (drizzle tracks
-- applied migrations) and swallowing duplicates keeps it idempotent.
DO $$
BEGIN
	ALTER TABLE "alert_destinations" REPLICA IDENTITY FULL;
	ALTER TABLE "scrape_target_checks" REPLICA IDENTITY FULL;

	ALTER PUBLICATION electric_publication_default ADD TABLE
		"alert_destinations",
		"scrape_target_checks";
EXCEPTION
	WHEN duplicate_object THEN
		RAISE NOTICE 'electric publication already includes the wave-1 tables, skipping';
	WHEN OTHERS THEN
		RAISE NOTICE 'electric publication wave-1 migration skipped: %', SQLERRM;
END $$;
