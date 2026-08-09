-- ElectricSQL sync — investigations.
--
-- The investigation detail page used to poll `/v2/investigations/:id` every 3s
-- while a run was in flight, which capped how live the provenance canvas could
-- ever feel: a lens transition was up to 3s stale, and the elapsed readout had to
-- be ticked client-side because a poll can't carry a clock. Both tables are
-- published here so the page reads a live shape instead.
--
-- Shapes over these tables are additionally scoped to ONE investigation by the
-- sync proxy (`org_id = $1 AND id/investigation_id = $2`), so a browser syncs the
-- run it is looking at and never the org's whole investigation history. That is
-- the first parameterised shape in the proxy — see `SHAPES` in
-- apps/electric-sync/src/routes/shape.http.ts.
--
-- REPLICA IDENTITY FULL matches the five tables already in this publication. It
-- is the cost 0022 pruned other tables for — every UPDATE writes the entire old
-- row to the WAL — and `investigation_lens_runs` carries jsonb blobs
-- (evidence_json, hypothesis_json) while `progress_note` updates every few
-- seconds during a run. Accepted here because the write volume is bounded by
-- concurrent investigations, not by ingest rate: `error_issues`, the table 0022
-- called out, was written on every error rollup.
--
-- Guarded like 0009/0011/0014 rather than 0022: this migration ADDs to the
-- publication, and the embedded PGlite test path (readBundledMigrationsSql → one
-- pglite.exec of every *.sql) supports neither ALTER PUBLICATION nor the
-- pg_publication_tables catalog, so an unguarded statement aborts every test
-- database. The guard's known downside is that it can also hide a real failure on
-- local Postgres — if shapes come back empty, check the publication by hand
-- (docs/electric-sync.md, "Troubleshooting").
DO $$
BEGIN
	ALTER TABLE "investigations" REPLICA IDENTITY FULL;
	ALTER TABLE "investigation_lens_runs" REPLICA IDENTITY FULL;

	ALTER PUBLICATION electric_publication_default ADD TABLE
		"investigations",
		"investigation_lens_runs";
EXCEPTION
	WHEN duplicate_object THEN
		RAISE NOTICE 'electric publication already includes the investigation tables, skipping';
	WHEN OTHERS THEN
		RAISE NOTICE 'electric publication investigations migration skipped: %', SQLERRM;
END $$;
