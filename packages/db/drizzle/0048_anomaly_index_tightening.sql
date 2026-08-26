DROP INDEX "anomaly_detector_states_open_incident_idx";--> statement-breakpoint
DROP INDEX "error_incidents_org_status_idx";--> statement-breakpoint
CREATE INDEX "anomaly_detector_states_open_incident_idx" ON "anomaly_detector_states" USING btree ("org_id","open_incident_id") WHERE "anomaly_detector_states"."open_incident_id" is not null;--> statement-breakpoint
CREATE INDEX "error_incidents_org_status_idx" ON "error_incidents" USING btree ("org_id","status","last_triggered_at");