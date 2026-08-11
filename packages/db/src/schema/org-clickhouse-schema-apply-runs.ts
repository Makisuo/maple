import type { OrgId } from "@maple/domain"
import { integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"

/**
 * One in-flight / last schema-apply run per org. The schema-apply Cloudflare
 * Workflow writes progress here as it executes each step (structural DDL +
 * backfill chunks); the dashboard polls it via the apply-schema status endpoint.
 *
 * Single row per org (orgId pk) — a new apply overwrites the previous run's
 * progress. Durable migration bookkeeping still lives in ClickHouse's
 * `_maple_schema_migrations`; this table is only the UI-facing progress mirror.
 */
export const orgClickHouseSchemaApplyRuns = pgTable(
	"org_clickhouse_schema_apply_runs",
	{
		orgId: text("org_id").$type<OrgId>().notNull(),
		// Cloudflare Workflow instance id (for status()/dedup), null before kickoff.
		workflowInstanceId: text("workflow_instance_id"),
		// "queued" | "running" | "succeeded" | "failed"
		status: text("status").notNull(),
		// Human-readable current phase, e.g. "migration 4 · backfill service_overview_spans".
		phase: text("phase"),
		// Migration version currently being applied (null when between/!running).
		currentMigration: integer("current_migration"),
		stepsTotal: integer("steps_total"),
		stepsDone: integer("steps_done"),
		// Migration versions applied this run, and skipped-object summary.
		appliedVersions: jsonb("applied_versions").$type<unknown>(),
		skipped: jsonb("skipped").$type<unknown>(),
		errorMessage: text("error_message"),
		startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
		finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.orgId] })],
)

export type OrgClickHouseSchemaApplyRunRow = typeof orgClickHouseSchemaApplyRuns.$inferSelect
export type OrgClickHouseSchemaApplyRunInsert = typeof orgClickHouseSchemaApplyRuns.$inferInsert
