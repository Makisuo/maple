UPDATE "alert_rules"
SET
	"query_builder_draft_json" = jsonb_build_object(
		'id', 'alert-query',
		'name', 'A',
		'enabled', true,
		'hidden', false,
		'dataSource', 'metrics',
		'signalSource', 'default',
		'metricName', "metric_name",
		'metricType', "metric_type",
		'isMonotonic', "metric_type" = 'sum',
		'aggregation', "metric_aggregation",
		'whereClause', concat_ws(
			' AND ',
			CASE
				WHEN jsonb_typeof("service_names_json") = 'array'
					AND jsonb_array_length("service_names_json") > 0
				THEN 'service.name = ' || to_json(
					(
						SELECT string_agg(value, ',' ORDER BY ordinal)
						FROM jsonb_array_elements_text("service_names_json")
							WITH ORDINALITY AS services(value, ordinal)
					)
				)::text
			END,
			CASE
				WHEN jsonb_typeof("environments_json") = 'array'
					AND jsonb_array_length("environments_json") > 0
				THEN 'deployment.environment = ' || to_json(
					(
						SELECT string_agg(value, ',')
						FROM jsonb_array_elements_text("environments_json")
					)
				)::text
			END
		),
		'stepInterval', '',
		'orderByDirection', 'desc',
		'addOns', jsonb_build_object(
			'groupBy',
				"group_by" IS NOT NULL
				OR (
					jsonb_typeof("service_names_json") = 'array'
					AND jsonb_array_length("service_names_json") > 1
				),
			'having', false,
			'orderBy', false,
			'limit', false,
			'legend', false
		),
		'groupBy',
			CASE
				WHEN jsonb_typeof("service_names_json") = 'array'
					AND jsonb_array_length("service_names_json") > 1
				THEN jsonb_build_array('service.name')
				ELSE COALESCE("group_by"::jsonb, '[]'::jsonb)
			END,
		'having', '',
		'orderBy', '',
		'limit', '',
		'legend', ''
	),
	"signal_type" = 'builder_query',
	"service_names_json" = NULL,
	"environments_json" = NULL,
	"group_by" = NULL
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
