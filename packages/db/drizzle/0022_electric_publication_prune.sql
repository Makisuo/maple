-- ElectricSQL sync — prune unused tables from the replication slot.
--
-- `electric_publication_default` still carried four tables nothing reads any more:
--   * error_issues / actors / error_incidents — the errors vertical (0009) was moved
--     back onto the typed /v2 endpoints; `apps/web/src/lib/collections/errors.ts` is
--     gone and `org-collections.ts` never builds a collection for them.
--   * scrape_target_checks — added in 0011, then replaced by the per-target
--     `useScrapeTargetChecks` atom (v2 `scrapeTargets.listChecks`); its shape was
--     already dropped from the proxy whitelist, so the publication was the last
--     thing keeping it replicated.
--
-- Both halves of the cost are removed here:
--   1. Publication membership — every INSERT/UPDATE/DELETE on these tables was still
--      being decoded and shipped down Electric's replication slot for no consumer.
--      `error_issues` in particular is written on every ingest-side error rollup.
--   2. REPLICA IDENTITY FULL — set by 0009/0011 so Electric could key deletes and
--      emit WHERE-exit deletes. It makes every UPDATE/DELETE write the *entire* old
--      row into the WAL, which costs whether or not the table is published, so it is
--      reset to DEFAULT (primary key only).
--
-- Unlike 0009/0011 this is NOT wrapped in a `WHEN OTHERS` swallow: that guard hid a
-- real failure on local Postgres once (drizzle recorded 0009 applied with no
-- publication actually created — see docs/electric-sync.md "Troubleshooting"). The
-- statements below run fine on both real Postgres and PGlite, and idempotency comes
-- from an explicit `pg_publication_tables` check instead — so a genuine failure here
-- aborts the migration loudly, as it should. Dropping a table that was never
-- published, or running against a database where the publication does not exist at
-- all, is a no-op.
DO $$
DECLARE
	unsynced_table text;
BEGIN
	FOREACH unsynced_table IN ARRAY ARRAY['error_issues', 'actors', 'error_incidents', 'scrape_target_checks'] LOOP
		IF EXISTS (
			SELECT 1
			FROM pg_publication_tables
			WHERE pubname = 'electric_publication_default'
				AND schemaname = 'public'
				AND tablename = unsynced_table
		) THEN
			EXECUTE format('ALTER PUBLICATION electric_publication_default DROP TABLE %I', unsynced_table);
		END IF;

		EXECUTE format('ALTER TABLE %I REPLICA IDENTITY DEFAULT', unsynced_table);
	END LOOP;
END $$;
