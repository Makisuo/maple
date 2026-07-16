-- ElectricSQL sync — API keys.
--
-- The API-key dashboard reads a column-restricted `api_keys` shape through the
-- authenticated sync proxy. Electric runs with manual table publishing in every
-- environment, so the table must be added to the existing publication explicitly.
-- The proxy projection excludes `key_hash` and `metadata_json`; publication-level
-- replication still carries the full row between Postgres and Electric.
--
-- Keep the PGlite/idempotency guard consistent with 0009 and 0011.
DO $$
BEGIN
	ALTER TABLE "api_keys" REPLICA IDENTITY FULL;
	ALTER PUBLICATION electric_publication_default ADD TABLE "api_keys";
EXCEPTION
	WHEN duplicate_object THEN
		RAISE NOTICE 'electric publication already includes api_keys, skipping';
	WHEN OTHERS THEN
		RAISE NOTICE 'electric publication api_keys migration skipped: %', SQLERRM;
END $$;
