import { describe, expect, it } from "vitest"
import { isBackfill, renderStatementFull, type BackfillSpec } from "../backfill"
import { migration_0004_service_namespace_projections } from "./0004_service_namespace_projections"
import { migration_0005_body_and_attr_indexes } from "./0005_body_and_attr_indexes"
import { migrations } from "./index"

const backfills = migration_0004_service_namespace_projections.statements.filter(
	isBackfill,
) as ReadonlyArray<BackfillSpec>

// Full rendered SQL (structural strings + backfills rendered to their full
// INSERT…SELECT, qualified into `default`) — what the non-chunking path runs.
const renderedSql = migration_0004_service_namespace_projections.statements
	.map((s) => renderStatementFull(s, "default"))
	.join("\n\n")

describe("ClickHouse migrations", () => {
	it("keeps migrations ordered with the body/attr-index delta last", () => {
		expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5])
		expect(migrations.at(-1)).toBe(migration_0005_body_and_attr_indexes)
	})

	it("adds body + attribute skip indexes as new-parts-only ADD INDEX statements", () => {
		const sql = migration_0005_body_and_attr_indexes.statements.join("\n")
		expect(sql).toContain(
			"ALTER TABLE logs ADD INDEX IF NOT EXISTS idx_body_tokens lower(Body) TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1",
		)
		expect(sql).toContain(
			"ALTER TABLE traces ADD INDEX IF NOT EXISTS idx_span_attr_items arrayMap((k, v) -> concat(k, '=', v), mapKeys(SpanAttributes), mapValues(SpanAttributes)) TYPE bloom_filter(0.01) GRANULARITY 1",
		)
		// Must NOT materialize — that would exceed the Worker subrequest budget on
		// billion-row parts; indexes apply to new parts and backfill via TTL churn.
		expect(sql).not.toContain("MATERIALIZE INDEX")
	})

	it("rebuilds namespace-aware log aggregates and recreates affected materialized views", () => {
		expect(renderedSql).toContain("ServiceNamespace LowCardinality(String) DEFAULT ''")
		expect(renderedSql).toContain("logs_aggregates_hourly__v4")
		expect(renderedSql).toContain(
			"ORDER BY (OrgId, Hour, ServiceName, SeverityText, DeploymentEnv, ServiceNamespace)",
		)
		expect(renderedSql).toContain("RENAME TABLE")
		expect(renderedSql).toContain("service_overview_spans_mv")
		expect(renderedSql).toContain("trace_list_mv_mv")
		expect(renderedSql).toContain("logs_aggregates_hourly_mv")
		expect(renderedSql).toContain(
			"INDEX idx_service_namespace ServiceNamespace TYPE set(1000) GRANULARITY 4",
		)
	})

	it("expresses the three heavy backfills as chunkable specs with explicit column lists", () => {
		// service_overview_spans + trace_list_mv from traces, logs aggregate from logs.
		expect(backfills.map((b) => b.target).sort()).toEqual([
			"logs_aggregates_hourly__v4",
			"service_overview_spans",
			"trace_list_mv",
		])

		const byTarget = Object.fromEntries(backfills.map((b) => [b.target, b]))
		expect(byTarget.service_overview_spans?.from).toBe("traces")
		expect(byTarget.service_overview_spans?.tsColumn).toBe("Timestamp")
		expect(byTarget.trace_list_mv?.from).toBe("traces")
		expect(byTarget.logs_aggregates_hourly__v4?.from).toBe("logs")
		expect(byTarget.logs_aggregates_hourly__v4?.tsColumn).toBe("TimestampTime")
		expect(byTarget.logs_aggregates_hourly__v4?.groupBy).toContain("OrgId, Hour")

		// Explicit column lists so appended columns never drift by position.
		expect(byTarget.service_overview_spans?.columns).toEqual([
			"OrgId",
			"Timestamp",
			"ServiceName",
			"Duration",
			"StatusCode",
			"TraceState",
			"DeploymentEnv",
			"CommitSha",
			"SampleRate",
			"ServiceNamespace",
		])
		expect(byTarget.trace_list_mv?.columns).toContain("ServiceNamespace")
		expect(byTarget.trace_list_mv?.columns).toContain("HasError")
	})

	it("renders backfills to positional-safe INSERT … (col, …) SELECT", () => {
		// No bare positional INSERT … SELECT (would silently drift on appended cols).
		expect(renderedSql).not.toMatch(
			/INSERT INTO `default`\.`(service_overview_spans|trace_list_mv|logs_aggregates_hourly__v4)` SELECT/,
		)
		expect(renderedSql).toContain(
			"INSERT INTO `default`.`service_overview_spans` (OrgId, Timestamp, ServiceName,",
		)
	})
})
