DROP INDEX "investigation_lens_runs_lens_idx";--> statement-breakpoint
ALTER TABLE "investigation_lens_runs" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "investigation_lens_runs_lens_idx" ON "investigation_lens_runs" USING btree ("investigation_id","attempt","lens_id");