import { describe, expect, it } from "vitest"
import { isBackfill, renderStatementFull, type BackfillSpec } from "../backfill"
import { migration_0004_service_namespace_projections } from "./0004_service_namespace_projections"
import { migration_0005_alert_checks_error_columns } from "./0005_alert_checks_error_columns"
import { migration_0006_db_edge_namespace } from "./0006_db_edge_namespace"
import {
	migration_0008_service_operations_minutely,
	serviceOperationsMinutelyBackfill,
} from "./0008_service_operations_minutely"
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
	it("keeps migrations ordered by version", () => {
		expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
		expect(migrations.at(-1)).toBe(migration_0008_service_operations_minutely)
	})

	it("adds the service-operation rollup and exposes a coordinated chunkable backfill", () => {
		const statements = migration_0008_service_operations_minutely.statements
		const sql = statements.map((statement) => renderStatementFull(statement, "default")).join("\n\n")

		expect(sql).toContain("PARTITION BY toDate(Minute)")
		expect(sql).toContain("ORDER BY (OrgId, ServiceName, DeploymentEnv, Minute, SpanName)")
		expect(sql).toContain("TTL toDate(Minute) + INTERVAL 90 DAY")
		expect(sql).toContain("SpanName String")
		expect(sql).toContain("quantilesTDigestState(0.5, 0.95)(Duration)")
		expect(sql).toContain("http.route")
		expect(sql).toContain("http.server %")
		expect(statements.filter(isBackfill)).toHaveLength(0)
		expect(sql).not.toContain("TRUNCATE TABLE service_operations_minutely")
		expect(serviceOperationsMinutelyBackfill.target).toBe("service_operations_minutely")
		expect(serviceOperationsMinutelyBackfill.from).toBe("traces")
		expect(serviceOperationsMinutelyBackfill.tsColumn).toBe("Timestamp")
		expect(serviceOperationsMinutelyBackfill.groupBy).toBe(
			"OrgId, Minute, ServiceName, DeploymentEnv, SpanName",
		)
	})

	it("adds alert_checks error columns as idempotent ALTERs", () => {
		for (const statement of migration_0005_alert_checks_error_columns.statements) {
			expect(statement).toContain("ALTER TABLE alert_checks ADD COLUMN IF NOT EXISTS")
		}
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

	it("rebuilds the db rollups with DbNamespace in the sorting key and recreates their MVs", () => {
		const sql = migration_0006_db_edge_namespace.statements
			.map((s) => renderStatementFull(s, "default"))
			.join("\n\n")
		expect(sql).toContain("service_map_db_edges_hourly__v6")
		expect(sql).toContain("service_map_db_query_shapes_hourly__v6")
		expect(sql).toContain("ORDER BY (OrgId, Hour, DeploymentEnv, ServiceName, DbSystem, DbNamespace)")
		expect(sql).toContain(
			"ORDER BY (OrgId, Hour, DeploymentEnv, ServiceName, DbSystem, DbNamespace, QueryKey)",
		)
		expect(sql).toContain("RENAME TABLE service_map_db_edges_hourly")
		expect(sql).toContain("RENAME TABLE service_map_db_query_shapes_hourly")
		// renderStatementFull qualifies object names with the database.
		expect(sql).toMatch(
			/CREATE MATERIALIZED VIEW IF NOT EXISTS [`default.]*service_map_db_edges_hourly_mv/,
		)
		expect(sql).toMatch(
			/CREATE MATERIALIZED VIEW IF NOT EXISTS [`default.]*service_map_db_query_shapes_hourly_mv/,
		)
		// The identity coalesce must appear in both MV bodies AND both backfills.
		expect(sql.match(/SpanAttributes\['db\.namespace'\]/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
	})

	it("expresses the db rollup rebuilds as chunkable backfills with explicit column lists", () => {
		const specs = migration_0006_db_edge_namespace.statements.filter(
			isBackfill,
		) as ReadonlyArray<BackfillSpec>
		expect(specs.map((b) => b.target).sort()).toEqual([
			"service_map_db_edges_hourly__v6",
			"service_map_db_query_shapes_hourly__v6",
		])
		for (const spec of specs) {
			expect(spec.from).toBe("traces")
			expect(spec.tsColumn).toBe("Timestamp")
			expect(spec.columns).toContain("DbNamespace")
			expect(spec.groupBy).toContain("DbNamespace")
			expect(spec.where).toContain("SpanKind IN ('Client', 'Producer')")
		}
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
