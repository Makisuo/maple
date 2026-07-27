ALTER TABLE "issue_escalations" ADD COLUMN "investigation_id" text;--> statement-breakpoint
ALTER TABLE "issue_escalations" ADD COLUMN "delivery_results_json" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "issue_escalations" AS escalation
SET "investigation_id" = escalation."run_id"
WHERE escalation."run_id" IS NOT NULL
	AND EXISTS (
		SELECT 1
		FROM "investigations"
		WHERE "investigations"."id" = escalation."run_id"
			AND "investigations"."org_id" = escalation."org_id"
	);
