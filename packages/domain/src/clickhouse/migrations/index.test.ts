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
import { migration_0013_service_map_ingest_bridge } from "./0013_service_map_ingest_bridge"
import { migration_0014_web_events, webEventsBackfill } from "./0014_web_events"
import { migration_0015_ai_classification_columns } from "./0015_ai_classification_columns"
import { migration_0016_service_ai_vendors_hourly } from "./0016_service_ai_vendors_hourly"
import { SERVICE_AI_VENDORS_HOURLY_SELECT_SQL } from "../../tinybird/ai-vendors-rollup-sql"
import { latestSnapshotStatements } from "../../generated/clickhouse-schema"
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
		expect(migrations.map((m) => m.version)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
		])
		expect(migrations.at(-1)).toBe(migration_0016_service_ai_vendors_hourly)
		expect(latestMigrationVersion).toBe(16)
		// 0010 and 0014 are performance/storage-only, so the ingest-gating version
		// skips both — nothing writes `web_events` directly and search indexes
		// change nothing the gateway sends, and bumping for either would un-ready
		// every BYO-CH org's routing for a change their ingest path never needs.
		expect(migration_0010_search_indexes.requiredForIngest).toBe(false)
		expect(migration_0014_web_events.requiredForIngest).toBe(false)

		// 0015 is different: the gateway's INSERT now names all five AI columns,
		// so a BYO cluster without them would reject every direct insert. Gating
		// on it is the designed fallback — an org stamped below 15 resolves
		// `clickhouse_ready = false` and routes to the managed pipeline until its
		// schema syncs.
		expect(migration_0015_ai_classification_columns.requiredForIngest).toBe(true)

		// 0016 adds a read-path rollup and touches nothing the gateway inserts, so
		// the ingest gate stays at 15. Bumping it would un-ready every BYO-CH org
		// over a table their ingest path never writes.
		expect(migration_0016_service_ai_vendors_hourly.requiredForIngest).toBe(false)
		expect(clickHouseSchemaVersion).toBe("15")
	})

	it("installs the AI vendor rollup and its live-write MV with no POPULATE and no backfill", () => {
		const sql = migration_0016_service_ai_vendors_hourly.statements.join("\n\n")

		expect(sql).toContain("CREATE TABLE IF NOT EXISTS service_ai_vendors_hourly")
		expect(sql).toContain("ENGINE = AggregatingMergeTree")
		// Daily partitions: a registry-fix rebuild is a per-closed-day atomic
		// REPLACE PARTITION, which monthly partitions would make unaffordable.
		expect(sql).toContain("PARTITION BY toYYYYMMDD(Hour)")
		// OrgId first so the one sanctioned mutation (org deletion) prunes.
		expect(sql).toContain("ORDER BY (OrgId, ServiceName, AiVendor, Hour)")
		// 400 days against a 30-day source — deliberate asymmetry, see the migration doc.
		expect(sql).toContain("TTL Hour + INTERVAL 400 DAY")

		// State types are not cast-compatible, so the value types are pinned to the
		// source columns: TraceId is String, AiSessionKeyHash is UInt64.
		expect(sql).toContain("TracesTotal AggregateFunction(uniqCombined(12), String)")
		expect(sql).toContain("TracesWithKey AggregateFunction(uniqCombined(12), String)")
		expect(sql).toContain("SessionsApprox AggregateFunction(uniqCombined(12), UInt64)")

		expect(sql).toContain(
			"CREATE MATERIALIZED VIEW IF NOT EXISTS service_ai_vendors_hourly_mv TO service_ai_vendors_hourly",
		)
		// The filter is the cost model and the semantics: non-AI spans never reach
		// the HLL states, and post-enablement "no rows" means "no AI spans".
		expect(sql).toContain("WHERE AiVendor != ''")
		// The stored clamped hour, not toStartOfHour(Timestamp) — a skewed client
		// must not be able to open a partition in 2038.
		expect(sql).toContain("AiRollupHour AS Hour")
		// Adjusted-count convention with the zero/unset floor.
		expect(sql).toContain("sum(if(SampleRate > 0, SampleRate, 1.0)) AS WeightedSpanCount")

		// Correctness here depends on the source rows having been classified, not
		// on the view having existed, so there is nothing safe to backfill and the
		// §8 runbook gate (flag at 100% for a full clock hour) covers the boundary.
		expect(sql).not.toContain("POPULATE")
		expect(migration_0016_service_ai_vendors_hourly.statements.filter(isBackfill)).toHaveLength(0)
	})

	it("keeps the migrated AI rollup view identical to the deployed one", () => {
		// A BYO cluster migrated to 16 and a freshly bootstrapped one must compute
		// the same coverage ratio. Both bodies come from one exported constant;
		// this asserts neither copy drifted away from it.
		const migrationMv = migration_0016_service_ai_vendors_hourly.statements.find((statement) =>
			statement.includes("CREATE MATERIALIZED VIEW"),
		)
		const snapshotMv = latestSnapshotStatements.find((statement) =>
			statement.includes("CREATE MATERIALIZED VIEW IF NOT EXISTS service_ai_vendors_hourly_mv"),
		)

		expect(migrationMv).toContain(SERVICE_AI_VENDORS_HOURLY_SELECT_SQL)
		expect(snapshotMv).toContain(SERVICE_AI_VENDORS_HOURLY_SELECT_SQL)
	})

	it("keeps the AI rollup MV projection in the target's column order", () => {
		// An MV writes into its target positionally. Every counter here is one of
		// two ClickHouse types, so a reordered SELECT transposes columns silently —
		// KeyAbsentCount and KeyInvalidCount would simply swap meanings.
		const expectedOrder = [
			"OrgId",
			"ServiceName",
			"AiVendor",
			"Hour",
			"SpanCount",
			"WeightedSpanCount",
			"EligibleSpanCount",
			"KeyAbsentCount",
			"KeyInvalidCount",
			"KeySubSessionCount",
			"KeySessionCount",
			"TracesTotal",
			"TracesWithKey",
			"SessionsApprox",
			"RowRulesVersionMin",
			"RowRulesVersionMax",
			"RollupRulesVersion",
		]

		const createTable = migration_0016_service_ai_vendors_hourly.statements.find((statement) =>
			statement.startsWith("CREATE TABLE"),
		)!
		const tableColumns = createTable
			.split("\n")
			.slice(1, expectedOrder.length + 1)
			.map((line) => line.trim().split(" ")[0]!)

		const selectColumns = SERVICE_AI_VENDORS_HOURLY_SELECT_SQL.split("\n")
			.slice(1, expectedOrder.length + 1)
			.map((line) => line.trim().replace(/,$/, ""))
			.map((line) => (line.includes(" AS ") ? line.slice(line.lastIndexOf(" AS ") + 4) : line))

		expect(tableColumns).toEqual(expectedOrder)
		expect(selectColumns).toEqual(expectedOrder)
	})

	it("adds the AI classification columns as defaulted trailing columns with no mutation", () => {
		const sql = migration_0015_ai_classification_columns.statements.join("\n")

		// Every column defaulted: that is what makes the ALTER metadata-only and
		// keeps rows written before the classifier shipped readable
		// (`AiRulesVersion = 0` = never examined).
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS AiVendor LowCardinality(String) DEFAULT ''")
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS AiSessionKeyState UInt8 DEFAULT 0")
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS AiSessionKeyHash UInt64 DEFAULT 0")
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS AiRulesVersion UInt32 DEFAULT 0")
		expect(sql).toContain("ADD COLUMN IF NOT EXISTS AiRollupHour DateTime('UTC') DEFAULT toDateTime(0)")
		expect(sql).toContain("ADD INDEX IF NOT EXISTS idx_ai_vendor AiVendor TYPE set(0) GRANULARITY 4")
		expect(sql).toContain(
			"ADD INDEX IF NOT EXISTS idx_scope_name ScopeName TYPE tokenbf_v1(4096, 3, 0) GRANULARITY 4",
		)

		// Nothing here may rewrite parts: the 30-day TTL retires unindexed parts on
		// its own, and a whole-table mutation on `traces` is the expensive mistake.
		expect(sql).not.toContain("MATERIALIZE INDEX")
		expect(sql).not.toContain("MATERIALIZE COLUMN")
		expect(sql).not.toContain("OPTIMIZE TABLE")
		expect(migration_0015_ai_classification_columns.statements.filter(isBackfill)).toHaveLength(0)
	})

	it("installs web_events with a live-write MV and no POPULATE", () => {
		const sql = migration_0014_web_events.statements.filter((stmt) => !isBackfill(stmt)).join("\n")

		// Time-first sorting key is the entire point of the table: session_events
		// is sorted (OrgId, SessionId, Timestamp, Seq), so a time range there can
		// only prune partitions.
		expect(sql).toContain("ORDER BY (OrgId, Timestamp, SessionId, Seq)")
		expect(sql).toContain("INDEX idx_event_name EventName TYPE set(64) GRANULARITY 4")
		expect(sql).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS web_events_mv TO web_events")
		expect(sql).toContain("WHERE Type IN ('navigation', 'custom')")

		// POPULATE would race the view's own writes into a table with no dedup, and
		// it is unchunked — history comes from `webEventsBackfill` instead, which
		// the apply plan splits into day-aligned steps and which runs while no
		// writer is attached.
		expect(sql).not.toContain("POPULATE")

		// `Kind` carries the source `Type` through untouched so the page-view
		// predicate stays provably identical to the pre-rollup `Type = 'navigation'`
		// even when a customer calls `track('$pageview')`.
		expect(sql).toContain("Type AS Kind")
	})

	it("orders the web_events backfill so it can never overlap the materialized view", () => {
		// The whole double-count hazard is an ordering property, and nothing else
		// checks it. web_events has no dedup, so a backfill running while the view
		// is attached counts every page view in the overlap twice.
		const kinds = migration_0014_web_events.statements.map((stmt) =>
			isBackfill(stmt)
				? "backfill"
				: String(stmt).includes("CREATE MATERIALIZED VIEW")
					? "create-view"
					: String(stmt).includes("DROP VIEW")
						? "drop-view"
						: String(stmt).includes("TRUNCATE")
							? "truncate"
							: "create-table",
		)
		expect(kinds).toEqual(["drop-view", "create-table", "truncate", "backfill", "create-view"])

		// Restated as the invariant rather than the sequence, so a future insertion
		// between them still has to preserve it.
		expect(kinds.indexOf("backfill")).toBeLessThan(kinds.indexOf("create-view"))
		expect(kinds.indexOf("drop-view")).toBeLessThan(kinds.indexOf("truncate"))
		expect(kinds.indexOf("truncate")).toBeLessThan(kinds.indexOf("backfill"))
	})

	it("keeps the web_events backfill projection identical to its materialized view", () => {
		// Two divergent copies of this SELECT would show up as a page-view count
		// that steps at the backfill boundary — on a table with no dedup, nothing
		// else would catch it.
		const mvBody = migration_0014_web_events.statements.find((s) =>
			String(s).includes("CREATE MATERIALIZED VIEW"),
		)
		expect(String(mvBody)).toContain(webEventsBackfill.select)
		expect(webEventsBackfill.where).toBe("Type IN ('navigation', 'custom')")
		expect(webEventsBackfill.from).toBe("session_events")
		expect(webEventsBackfill.tsColumn).toBe("Timestamp")
		// Row-wise: no GROUP BY means no group can straddle a chunk boundary.
		expect(webEventsBackfill.groupBy).toBeUndefined()
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

	it("routes service-map rollup writes through a zero-retention plain-schema bridge", () => {
		const ingressTable = migration_0013_service_map_ingest_bridge.statements.find((statement) =>
			statement.startsWith("CREATE TABLE IF NOT EXISTS service_map_edges_hourly_ingest"),
		)
		const ingressView = migration_0013_service_map_ingest_bridge.statements.find((statement) =>
			statement.startsWith("CREATE MATERIALIZED VIEW IF NOT EXISTS service_map_edges_hourly_ingest_mv"),
		)

		expect(ingressTable).toContain("ENGINE = Null")
		expect(ingressTable).toContain("CallCount UInt64")
		expect(ingressTable).not.toContain("AggregateFunction(")
		expect(ingressView).toContain("TO service_map_edges_hourly")
		expect(renderStatementFull(ingressView!, "maple")).toContain(
			"FROM `maple`.`service_map_edges_hourly_ingest`",
		)
		expect(migrations.find((m) => m.version === 13)?.requiredForIngest).toBeUndefined()
	})

	it("adds the incremental minutely error rollup without replacing the deployed time-copy view", () => {
		const sql = migration_0013_service_map_ingest_bridge.statements.join("\n\n")
		const minutelyView = migration_0013_service_map_ingest_bridge.statements.find((statement) =>
			statement.startsWith("CREATE MATERIALIZED VIEW IF NOT EXISTS error_fingerprints_minutely_mv"),
		)

		expect(sql).toContain("CREATE TABLE IF NOT EXISTS error_fingerprints_minutely")
		expect(sql).toContain("PARTITION BY toYYYYMM(Minute)")
		expect(sql).toContain("ORDER BY (OrgId, Minute, FingerprintHash)")
		expect(minutelyView).toContain("FROM error_events")
		expect(renderStatementFull(minutelyView!, "maple")).toContain("FROM `maple`.`error_events`")
		expect(sql).not.toContain("DROP TABLE IF EXISTS error_events_by_time_mv")
		expect(sql).not.toContain("DROP VIEW IF EXISTS error_events_by_time_mv")
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
