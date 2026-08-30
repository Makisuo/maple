-- ElectricSQL sync — a second publication for the self-hosted sync service.
--
-- Electric Cloud is going away, so `apps/electric` now runs the sync engine on
-- ECS. The two cannot share one Postgres replication slot: whichever connects
-- second is refused with `replication slot is active`. That would make the
-- cutover a leap — delete the Cloud source, then find out whether the new
-- service comes up — with no way back once Cloud is gone.
--
-- So the self-hosted service reads its OWN stream. Electric derives both the
-- publication and the slot name from `ELECTRIC_REPLICATION_STREAM_ID`
-- (`electric_publication_<id>` / `electric_slot_<id>`), which is set to `maple`
-- in `packages/infra/src/aws/stage.ts`. Both services then replicate the same
-- tables from the same database at the same time, and flipping `ELECTRIC_URL`
-- between them is a reversible env change.
--
-- Membership is DERIVED from `electric_publication_default` rather than
-- restated. A hardcoded list here would be a second copy of a set that four
-- migrations have already edited (0009, 0011, 0014, 0022, 0037), and the copy
-- would be wrong the first time anyone forgot it. `REPLICA IDENTITY FULL` is
-- already set on every one of these tables by those migrations, and it is a
-- property of the table, not of a publication — nothing to repeat here.
--
-- WHILE BOTH PUBLICATIONS EXIST, a migration that adds or removes a synced table
-- must touch BOTH. `migrations.test.ts` asserts they hold the same set, so
-- forgetting fails the suite rather than silently starving a shape.
--
-- The transitional state ends when the Cloud source is deleted: drop
-- `electric_publication_default` in a follow-up and `electric_publication_maple`
-- is simply the publication. Do NOT instead rename the stream back to `default`
-- — that drops and rebuilds the slot, forcing a full re-snapshot of every shape
-- for every connected client, to save a suffix.
--
-- Not wrapped in a `WHEN OTHERS` swallow (0022's reasoning): PGlite runs
-- CREATE/ALTER PUBLICATION and reads `pg_publication_tables` fine — the embedded
-- test path asserts exactly that — so a genuine failure here should abort loudly
-- instead of being recorded as applied. Idempotency comes from the explicit
-- existence check.
DO $$
DECLARE
	members text;
BEGIN
	IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'electric_publication_maple') THEN
		RETURN;
	END IF;

	SELECT string_agg(format('%I', tablename), ', ' ORDER BY tablename)
	INTO members
	FROM pg_publication_tables
	WHERE pubname = 'electric_publication_default'
		AND schemaname = 'public';

	IF members IS NULL THEN
		RAISE EXCEPTION 'electric_publication_default is absent or empty — refusing to create an empty electric_publication_maple (see docs/electric-sync.md "Troubleshooting")';
	END IF;

	EXECUTE format('CREATE PUBLICATION electric_publication_maple FOR TABLE %s', members);
END $$;
