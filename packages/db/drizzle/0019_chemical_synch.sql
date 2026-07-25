-- Not CONCURRENTLY: both runners apply a migration file inside a transaction
-- (drizzle-kit for deployed Postgres, a single `pglite.exec` for tests), and
-- CREATE/DROP INDEX CONCURRENTLY cannot run in one. At ~270k rows the plain
-- build takes a couple of seconds under a SHARE lock — writers to error_issues
-- stall for that window, readers are unaffected, and the alerting tick that
-- writes it already retries on busy.
DROP INDEX "anomaly_detector_states_org_idx";--> statement-breakpoint
DROP INDEX "error_issue_states_org_idx";--> statement-breakpoint
CREATE INDEX "error_issues_org_archived_idx" ON "error_issues" USING btree ("org_id","archived_at") WHERE "error_issues"."archived_at" is not null;
