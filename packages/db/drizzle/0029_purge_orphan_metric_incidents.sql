-- Finish 0026's removal of the `metric` signal type.
--
-- 0026 deleted metric-signal incidents by joining back to `alert_rules`:
--
--   DELETE FROM "alert_incidents"
--   WHERE "rule_id" IN (SELECT "id" FROM "alert_rules" WHERE "signal_type" = 'metric');
--
-- `alert_incidents.signal_type` is its own NOT NULL column, denormalized off the rule at
-- open time, so an incident whose rule had already been deleted matched no row in that
-- subquery and kept `signal_type = 'metric'`. `metric` is no longer a member of
-- AlertSignalType, and the web's Electric mapper decodes the column with
-- `Schema.decodeUnknownSync` (rowToAlertIncidentDocument, apps/web/src/lib/collections/alerts.ts),
-- so a single surviving row throws `Expected @maple/AlertSignalType, got "metric"` inside the
-- alerts-list useMemo and white-screens the whole page for that org.
--
-- Delete by each table's own column rather than by rule. The `alert_rules` statement is a
-- no-op wherever 0026 already ran and a safety net wherever it did not.
DELETE FROM "alert_delivery_events"
WHERE "incident_id" IN (
	SELECT "id" FROM "alert_incidents" WHERE "signal_type" = 'metric'
);--> statement-breakpoint
DELETE FROM "alert_incidents"
WHERE "signal_type" = 'metric';--> statement-breakpoint
DELETE FROM "alert_delivery_events"
WHERE "rule_id" IN (
	SELECT "id" FROM "alert_rules" WHERE "signal_type" = 'metric'
);--> statement-breakpoint
DELETE FROM "alert_rule_states"
WHERE "rule_id" IN (
	SELECT "id" FROM "alert_rules" WHERE "signal_type" = 'metric'
);--> statement-breakpoint
DELETE FROM "alert_rules"
WHERE "signal_type" = 'metric';
