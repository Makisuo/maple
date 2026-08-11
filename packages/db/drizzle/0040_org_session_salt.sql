ALTER TABLE "org_ingest_keys" ADD COLUMN "session_salt_ciphertext" text;--> statement-breakpoint
ALTER TABLE "org_ingest_keys" ADD COLUMN "session_salt_iv" text;--> statement-breakpoint
ALTER TABLE "org_ingest_keys" ADD COLUMN "session_salt_tag" text;