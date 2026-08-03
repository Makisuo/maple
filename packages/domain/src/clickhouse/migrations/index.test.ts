import { describe, expect, it } from "vitest"
import { type BackfillSpec, isBackfill, renderStatementFull } from "../backfill"
import { migration_0004_service_namespace_projections } from "./0004_service_namespace_projections"
import { migration_0005_alert_checks_error_columns } from "./0005_alert_checks_error_columns"
import { migration_0006_db_edge_namespace } from "./0006_db_edge_namespace"
import {
	migration_0008_service_operations_minutely,
	serviceOperationsMinutelyBackfill,
} from "./0008_service_operations_minutely"
import {
	migration_0009_one_year_service_history,
	serviceOperationsHourlyBackfill,
	serviceOverviewHourlyBackfill,
} from "./0009_one_year_service_history"
import { migration_0010_search_indexes } from "./0010_search_indexes"
import { migration_0011_session_analytics_columns } from "./0011_session_analytics_columns"
import { migration_0012_session_event_attribute_keys } from "./0012_session_event_attribute_keys"
import { clickHouseSchemaVersion, latestMigrationVersion, migrations } from "./index"

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
		expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
		expect(migrations.at(-1)).toBe(migration_0012_session_event_attribute_keys)
		expect(latestMigrationVersion).toBe(12)
		// 0010 is performance-only, so the ingest-gating version skips it: 9 → 12.
		expect(clickHouseSchemaVersion).toBe("12")
		expect(migration_0010_search_indexes.requiredForIngest).toBe(false)
	})

	it("adds session analytics columns with defaults so older SDK rows never quarantine", () => {
		const sql = migration_0011_session_analytics_columns.statements.join("\n")

		expect(sql).toContain("ADD COLUMN IF NOT EXISTS VisitorId String DEFAULT ''")
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS GroupId String DEFAULT ''")
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS UserTraits Map(String, String) DEFAULT map()")
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS ReferrerHost LowCardinality(String) DEFAULT ''")
		expect(sql).toContain("ADD INDEX IF NOT EXISTS idx_type Type TYPE set(16)")

		// Every session_replays column add must carry a DEFAULT — Tinybird
		// quarantines rows omitting a non-defaulted column, which is exactly what
		// an older SDK sends. Nullable columns default to NULL implicitly.
		const columnAdds = migration_0011_session_analytics_columns.statements.filter((s) =>
			s.includes("ADD COLUMN"),
		)
		for (const statement of columnAdds) {
			expect(statement.includes("DEFAULT") || statement.includes("Nullable(")).toBe(true)
		}

		// Gates direct ingest: the native INSERT names every column explicitly, so
		// a BYO cluster without them must not be routed direct writes. Read off the
		// typed array — the migration literal itself simply omits the field.
		expect(migrations.find((m) => m.version === 11)?.requiredForIngest).toBeUndefined()
	})

	it("widens session_events attribute keys off the shared dictionary", () => {
		// `track()` props are customer-named, so the keys stop being a small fixed
		// set. MODIFY COLUMN is a mutation, not a metadata edit — it lives alone in
		// its own migration for that reason.
		expect(migration_0012_session_event_attribute_keys.statements).toEqual([
			"ALTER TABLE session_events MODIFY COLUMN Attributes Map(String, String)",
		])
		expect(migrations.find((m) => m.version === 12)?.requiredForIngest).toBeUndefined()
	})

	it("adds the portable search substrate without requiring experimental text indexes", () => {
		const sql = migration_0010_search_indexes.statements.join("\n")

		expect(sql).toContain("ResourceAttributeItems Array(String) DEFAULT arrayMap")
		expect(sql).toContain("LogAttributeItems Array(String) DEFAULT arrayMap")
		expect(sql).toContain("SpanAttributeItems Array(String) DEFAULT arrayMap")
		expect(sql).toContain("concat(k, char(31), v)")
		expect(sql).toContain("idx_lower_body lower(Body) TYPE tokenbf_v1")
		expect(sql).toContain("idx_log_attr_keys mapKeys(LogAttributes) TYPE bloom_filter")
		expect(sql).not.toContain("MATERIALIZE INDEX")
		expect(sql).not.toContain("TYPE text(")
		expect(sql).not.toContain("OPTIMIZE TABLE")
	})

	it("adds monthly annual service rollups and coordinated retained-source backfills", () => {
		const sql = migration_0009_one_year_service_history.statements
			.map((statement) => renderStatementFull(statement, "default"))
			.join("\n\n")

		expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS .*service_overview_hourly/)
		expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS .*service_operations_hourly/)
		expect(sql.match(/PARTITION BY toYYYYMM\(Hour\)/g)).toHaveLength(2)
		expect(sql.match(/TTL toDate\(Hour\) \+ INTERVAL 365 DAY/g)?.length).toBeGreaterThanOrEqual(2)
		expect(sql).toContain("quantilesTDigestState(0.5, 0.95, 0.99)(Duration)")
		expect(sql).toContain("quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles)")
		expect(sql).toContain("Duration < 500000000")
		expect(sql).toContain("ALTER TABLE alert_checks MODIFY TTL")
		expect(sql).toContain("ALTER TABLE traces_aggregates_hourly MODIFY TTL")
		expect(sql).toContain("ALTER TABLE logs_aggregates_hourly MODIFY TTL")
		expect(migration_0009_one_year_service_history.statements.filter(isBackfill)).toEqual([
			serviceOverviewHourlyBackfill,
			serviceOperationsHourlyBackfill,
		])

		expect(serviceOverviewHourlyBackfill.from).toBe("service_overview_spans")
		expect(serviceOverviewHourlyBackfill.tsColumn).toBe("Timestamp")
		expect(serviceOperationsHourlyBackfill.from).toBe("service_operations_minutely")
		expect(serviceOperationsHourlyBackfill.tsColumn).toBe("Minute")
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
