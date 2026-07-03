ALTER TABLE "cloudflare_analytics_state" ADD COLUMN IF NOT EXISTS "backfill_at" timestamp with time zone;
