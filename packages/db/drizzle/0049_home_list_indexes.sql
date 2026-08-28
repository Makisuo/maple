CREATE INDEX "anomaly_incidents_org_status_triggered_idx" ON "anomaly_incidents" USING btree ("org_id","status","last_triggered_at","id");--> statement-breakpoint
CREATE INDEX "error_issues_org_live_seen_idx" ON "error_issues" USING btree ("org_id","last_seen_at","id") WHERE "error_issues"."archived_at" is null;--> statement-breakpoint
DROP INDEX "anomaly_incidents_org_status_idx";--> statement-breakpoint
DROP INDEX "error_issues_org_last_seen_idx";
