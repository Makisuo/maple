DELETE FROM "alert_delivery_events"
WHERE "rule_id" IN (
	SELECT "id" FROM "alert_rules" WHERE "signal_type" = 'metric'
);--> statement-breakpoint
DELETE FROM "alert_incidents"
WHERE "rule_id" IN (
	SELECT "id" FROM "alert_rules" WHERE "signal_type" = 'metric'
);--> statement-breakpoint
DELETE FROM "alert_rule_states"
WHERE "rule_id" IN (
	SELECT "id" FROM "alert_rules" WHERE "signal_type" = 'metric'
);--> statement-breakpoint
DELETE FROM "alert_rules"
WHERE "signal_type" = 'metric';--> statement-breakpoint
UPDATE "alert_rules" AS rules
SET "destination_ids_json" = COALESCE(
	(
		SELECT jsonb_agg(destination_id)
		FROM jsonb_array_elements_text(rules."destination_ids_json") AS ids(destination_id)
		WHERE NOT EXISTS (
			SELECT 1
			FROM "alert_destinations" AS destinations
			WHERE destinations."id" = destination_id
				AND destinations."type" IN ('slack', 'hazel')
		)
	),
	'[]'::jsonb
)
WHERE EXISTS (
	SELECT 1
	FROM jsonb_array_elements_text(rules."destination_ids_json") AS ids(destination_id)
	JOIN "alert_destinations" AS destinations ON destinations."id" = destination_id
	WHERE destinations."type" IN ('slack', 'hazel')
);--> statement-breakpoint
UPDATE "alert_rules"
SET "enabled" = false
WHERE "enabled" = true
	AND jsonb_array_length("destination_ids_json") = 0;--> statement-breakpoint
DELETE FROM "alert_delivery_events"
WHERE "destination_id" IN (
	SELECT "id"
	FROM "alert_destinations"
	WHERE "type" IN ('slack', 'hazel')
);--> statement-breakpoint
DELETE FROM "alert_destinations"
WHERE "type" IN ('slack', 'hazel');--> statement-breakpoint
ALTER TABLE "alert_rules" DROP COLUMN "metric_name";--> statement-breakpoint
ALTER TABLE "alert_rules" DROP COLUMN "metric_type";--> statement-breakpoint
ALTER TABLE "alert_rules" DROP COLUMN "metric_aggregation";
