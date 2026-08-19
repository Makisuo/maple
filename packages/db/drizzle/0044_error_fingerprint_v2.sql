ALTER TABLE "error_issues" ADD COLUMN "fingerprint_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "error_issues_org_fp_version_idx" ON "error_issues" USING btree ("org_id","fingerprint_version");--> statement-breakpoint
-- Cutover for fingerprint algorithm v2.
--
-- v2 matches stack frames by shape instead of by "contains a colon-digit", so
-- every error-kind hash rotates. The old rows can never receive another
-- occurrence and would otherwise sit in `triage` until the 14-day resolved
-- window retired them one by one. Over 90 days they numbered 68,550 for 114
-- distinct error labels; the same corpus fingerprints to ~2,000 under v2.
--
-- Scoped to kind = 'error'. Alert- and integration-kind issues key off
-- `alert:{ruleId}:{groupKey}`-style identifiers, not the ClickHouse fingerprint,
-- so their state is still valid and is deliberately left alone.
--
-- The tick cursor (error_tick_states) is NOT reset: the evaluator picks up from
-- where it left off and re-creates an issue the next time each live bug fires,
-- which for anything actually firing is within a tick. Resetting it would force
-- a full bootstrap re-scan for no benefit.
DELETE FROM "error_issue_events" WHERE "issue_id" IN (SELECT "id" FROM "error_issues" WHERE "kind" = 'error');--> statement-breakpoint
DELETE FROM "error_issue_states" WHERE "issue_id" IN (SELECT "id" FROM "error_issues" WHERE "kind" = 'error');--> statement-breakpoint
DELETE FROM "error_incidents" WHERE "issue_id" IN (SELECT "id" FROM "error_issues" WHERE "kind" = 'error');--> statement-breakpoint
-- Queued deliveries reference issues that no longer exist; drop the undelivered
-- ones so the outbox does not notify about a deleted issue.
DELETE FROM "error_notification_deliveries" WHERE "status" IN ('queued', 'processing');--> statement-breakpoint
DELETE FROM "error_issues" WHERE "kind" = 'error';
