ALTER TABLE "investigations" ADD COLUMN "snapshot_json" jsonb;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "investigations" ADD COLUMN "autonomous_turns" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Additive cutover: preserve every legacy diagnosis as a durable investigation.
-- Existing investigation rows win both primary-key and incident-dedup conflicts,
-- which makes this migration safe to replay against partially migrated stages.
INSERT INTO "investigations" (
	"id",
	"org_id",
	"status",
	"seeded_by",
	"subject_json",
	"snapshot_json",
	"incident_kind",
	"incident_id",
	"issue_id",
	"report_json",
	"severity",
	"confidence",
	"model",
	"input_tokens",
	"output_tokens",
	"error",
	"created_at",
	"started_at",
	"diagnosed_at",
	"updated_at",
	"autonomous_turns"
)
SELECT
	legacy."id",
	legacy."org_id",
	CASE
		WHEN legacy."status" = 'completed' THEN 'diagnosed'
		WHEN legacy."status" = 'failed' THEN 'failed'
		ELSE 'investigating'
	END,
	'system',
	jsonb_strip_nulls(jsonb_build_object(
		'type', 'incident',
		'incidentKind', legacy."incident_kind",
		'incidentId', legacy."incident_id",
		'issueId', legacy."issue_id"
	)),
	jsonb_build_object(
		'title', coalesce(
			legacy."context_json"->>'title',
			legacy."context_json"->>'exceptionMessage',
			legacy."context_json"->>'summary',
			initcap(legacy."incident_kind") || ' incident'
		),
		'scope', coalesce(
			legacy."context_json"->>'serviceName',
			legacy."result_json"->>'affectedScope'
		),
		'status', CASE
			WHEN legacy."status" = 'completed' THEN 'diagnosed'
			ELSE legacy."status"
		END,
		'severity', legacy."result_json"->>'severityAssessment',
		'facts', jsonb_build_array(jsonb_build_object(
			'label', 'Incident',
			'value', legacy."incident_id"
		)),
		'references', '[]'::jsonb,
		'incidentStartedAt', null,
		'incidentEndedAt', null
	),
	legacy."incident_kind",
	legacy."incident_id",
	legacy."issue_id",
	legacy."result_json",
	legacy."result_json"->>'severityAssessment',
	legacy."result_json"->>'confidence',
	legacy."model",
	legacy."input_tokens",
	legacy."output_tokens",
	legacy."error",
	legacy."created_at",
	legacy."started_at",
	legacy."completed_at",
	legacy."updated_at",
	1
FROM "ai_triage_runs" AS legacy
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Rows created by an earlier investigations release did not have a snapshot.
-- Populate a conservative, source-independent fallback for historical display.
UPDATE "investigations"
SET "snapshot_json" = jsonb_build_object(
	'title', CASE
		WHEN "subject_json"->>'type' = 'freeform'
			THEN coalesce("subject_json"->>'title', 'Investigation')
		ELSE initcap(coalesce("incident_kind", 'incident')) || ' incident'
	END,
	'scope', null,
	'status', "status",
	'severity', "severity",
	'facts', CASE
		WHEN "incident_id" IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
			'label', 'Incident',
			'value', "incident_id"
		))
		ELSE '[]'::jsonb
	END,
	'references', '[]'::jsonb,
	'incidentStartedAt', null,
	'incidentEndedAt', null
)
WHERE "snapshot_json" IS NULL;
