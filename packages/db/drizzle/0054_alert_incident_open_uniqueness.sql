-- Duplicate open incidents predate these constraints (expired scheduler/org
-- claims let two ticks open the same incident); resolve all but the freshest
-- per key first or the CREATEs fail validation.
WITH ranked AS (
	SELECT id, row_number() OVER (
		PARTITION BY org_id, rule_id, group_key
		ORDER BY last_triggered_at DESC, id DESC
	) AS rn
	FROM alert_incidents WHERE status = 'open' AND group_key IS NOT NULL
)
UPDATE alert_incidents SET status = 'resolved', resolved_at = now(), updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);--> statement-breakpoint
WITH ranked AS (
	SELECT id, row_number() OVER (
		PARTITION BY org_id, detector_key
		ORDER BY last_triggered_at DESC, id DESC
	) AS rn
	FROM anomaly_incidents WHERE status = 'open'
)
UPDATE anomaly_incidents SET status = 'resolved', resolved_at = now(), updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);--> statement-breakpoint
CREATE UNIQUE INDEX "alert_incidents_open_group_idx" ON "alert_incidents" USING btree ("org_id","rule_id","group_key") WHERE "alert_incidents"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "anomaly_incidents_open_detector_idx" ON "anomaly_incidents" USING btree ("org_id","detector_key") WHERE "anomaly_incidents"."status" = 'open';
