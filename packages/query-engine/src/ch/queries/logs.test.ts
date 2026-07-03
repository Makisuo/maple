import { describe, expect, it } from "vitest"
import { compileCH, compileUnion } from "@maple-dev/clickhouse-builder"
import {
	canUseLogsAggregatesHourly,
	logsTimeseriesQuery,
	logsBreakdownQuery,
	logsCountQuery,
	logsListQuery,
	getLogByKeyQuery,
	errorRateByServiceQuery,
	logsFacetsQuery,
} from "./logs"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
	bucketSeconds: 3600,
}

// ---------------------------------------------------------------------------
// logsTimeseriesQuery
// ---------------------------------------------------------------------------

describe("logsTimeseriesQuery", () => {
	it("compiles basic timeseries with no groupBy", () => {
		const q = logsTimeseriesQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("toStartOfInterval")
		expect(sql).toContain("INTERVAL 3600 SECOND")
		expect(sql).toContain("'all' AS groupName")
		expect(sql).toContain("count() AS count")
		expect(sql).toContain("GROUP BY bucket, groupName")
		expect(sql).toContain("ORDER BY bucket ASC, groupName ASC")
		expect(sql).toContain("FORMAT JSON")
	})

	it("groups by service", () => {
		const q = logsTimeseriesQuery({ groupBy: ["service"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("toString(ServiceName)")
		expect(sql).not.toContain("'all' AS groupName")
	})

	it("groups by severity", () => {
		const q = logsTimeseriesQuery({ groupBy: ["severity"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("toString(SeverityText)")
	})

	it("groups by service and severity", () => {
		const q = logsTimeseriesQuery({ groupBy: ["service", "severity"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("arrayFilter")
		expect(sql).toContain("arrayStringConcat")
	})

	it("applies serviceName filter", () => {
		const q = logsTimeseriesQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})

	it("applies severity filter", () => {
		const q = logsTimeseriesQuery({ severity: "ERROR" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("SeverityText = 'ERROR'")
	})
})

// ---------------------------------------------------------------------------
// canUseLogsAggregatesHourly + MV routing in logsTimeseriesQuery
// ---------------------------------------------------------------------------

describe("canUseLogsAggregatesHourly", () => {
	it("accepts hour-aligned bucket sizes", () => {
		expect(canUseLogsAggregatesHourly({}, 3600)).toBe(true)
		expect(canUseLogsAggregatesHourly({}, 7200)).toBe(true)
		expect(canUseLogsAggregatesHourly({}, 86400)).toBe(true)
	})

	it("rejects sub-hour and non-hour-aligned buckets", () => {
		expect(canUseLogsAggregatesHourly({}, 60)).toBe(false)
		expect(canUseLogsAggregatesHourly({}, 600)).toBe(false)
		expect(canUseLogsAggregatesHourly({}, 1800)).toBe(false)
		expect(canUseLogsAggregatesHourly({}, 5400)).toBe(false) // 1.5h
		expect(canUseLogsAggregatesHourly({}, undefined)).toBe(false)
	})

	it("rejects when filters need raw columns the MV doesn't carry", () => {
		expect(canUseLogsAggregatesHourly({ traceId: "abc" }, 3600)).toBe(false)
		expect(canUseLogsAggregatesHourly({ search: "boom" }, 3600)).toBe(false)
		expect(
			canUseLogsAggregatesHourly(
				{ environments: ["prod"], matchModes: { deploymentEnv: "contains" } },
				3600,
			),
		).toBe(false)
	})
})

describe("logsTimeseriesQuery MV routing", () => {
	it("routes to logs_aggregates_hourly at bucketSeconds=3600", () => {
		const q = logsTimeseriesQuery({ bucketSeconds: 3600 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).not.toContain("FROM logs\n")
		expect(sql).toContain("sum(Count) AS count")
		// Hour column is the partition + ORDER BY prefix.
		expect(sql).toContain("Hour >= '2024-01-01 00:00:00'")
		// Trailing partial hour clamp — strict-less-than at the floored upper bound.
		// `toDateTime(...)` wraps the literal so `toStartOfHour` gets a DateTime, not a String.
		expect(sql).toContain("Hour < toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
	})

	it("falls back to raw `logs` at sub-hour buckets", () => {
		const q = logsTimeseriesQuery({ bucketSeconds: 60 })
		const { sql } = compileCH(q, { ...baseParams, bucketSeconds: 60 })
		expect(sql).toContain("FROM logs")
		expect(sql).not.toContain("logs_aggregates_hourly")
		expect(sql).toContain("count() AS count")
	})

	it("falls back to raw `logs` when traceId is filtered", () => {
		const q = logsTimeseriesQuery({ bucketSeconds: 3600, traceId: "abc" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs")
		expect(sql).not.toContain("logs_aggregates_hourly")
	})

	it("falls back to raw `logs` when search is set", () => {
		const q = logsTimeseriesQuery({ bucketSeconds: 3600, search: "boom" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs")
		expect(sql).not.toContain("logs_aggregates_hourly")
	})

	it("uses DeploymentEnv column on the MV branch (not the resource-attr map)", () => {
		const q = logsTimeseriesQuery({ bucketSeconds: 3600, environments: ["production"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("DeploymentEnv IN ('production')")
		expect(sql).not.toContain("ResourceAttributes")
	})

	it("falls back to raw `logs` for `contains`-mode environment match", () => {
		const q = logsTimeseriesQuery({
			bucketSeconds: 3600,
			environments: ["prod"],
			matchModes: { deploymentEnv: "contains" },
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs")
		expect(sql).not.toContain("logs_aggregates_hourly")
		expect(sql).toContain("positionCaseInsensitive(ResourceAttributes['deployment.environment'], 'prod')")
	})
})

// ---------------------------------------------------------------------------
// logsBreakdownQuery
// ---------------------------------------------------------------------------

describe("logsBreakdownQuery", () => {
	it("uses the hourly aggregate for full interior hours when grouping by service", () => {
		const q = logsBreakdownQuery({ groupBy: "service" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("ServiceName AS name")
		expect(sql).toContain("sum(Count) AS count")
		expect(sql).toContain("count() AS count")
		expect(sql).toContain("GROUP BY name")
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 10")
		expect(sql).toContain("FORMAT JSON")
	})

	it("compiles breakdown by severity", () => {
		const q = logsBreakdownQuery({ groupBy: "severity" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("SeverityText AS name")
	})

	it("applies optional filters", () => {
		const q = logsBreakdownQuery({ groupBy: "service", serviceName: "api", severity: "ERROR" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("SeverityText = 'ERROR'")
	})

	it("falls back to raw logs for contains-mode environment match", () => {
		const q = logsBreakdownQuery({
			groupBy: "service",
			environments: ["prod"],
			matchModes: { deploymentEnv: "contains" },
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs")
		expect(sql).not.toContain("logs_aggregates_hourly")
		expect(sql).toContain("positionCaseInsensitive(ResourceAttributes['deployment.environment'], 'prod')")
	})

	it("applies custom limit", () => {
		const q = logsBreakdownQuery({ groupBy: "service", limit: 25 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 25")
	})
})

// ---------------------------------------------------------------------------
// logsCountQuery
// ---------------------------------------------------------------------------

describe("logsCountQuery", () => {
	it("uses the hourly aggregate for full interior hours and raw logs for exact edges", () => {
		const q = logsCountQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("sum(Count) AS total")
		expect(sql).toContain("count() AS total")
		expect(sql).toContain("sum(total) AS total")
		expect(sql).toContain("Hour >= if(")
		expect(sql).toContain("Hour < toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
		expect(sql).toContain("TimestampTime < if(")
		expect(sql).toContain("TimestampTime >= toStartOfHour(toDateTime('2024-01-02 00:00:00'))")
		expect(sql).toContain("FORMAT JSON")
		expect(sql).not.toContain("GROUP BY")
		expect(sql).not.toContain("ORDER BY")
	})

	it("applies search filter", () => {
		const q = logsCountQuery({ search: "exception" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs")
		expect(sql).not.toContain("logs_aggregates_hourly")
		expect(sql).toContain("Body ILIKE '%exception%'")
	})

	it("applies traceId filter", () => {
		const q = logsCountQuery({ traceId: "abc123" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs")
		expect(sql).not.toContain("logs_aggregates_hourly")
		expect(sql).toContain("TraceId = 'abc123'")
	})

	it("applies all filters simultaneously", () => {
		const q = logsCountQuery({ serviceName: "api", severity: "ERROR", search: "timeout" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs")
		expect(sql).not.toContain("logs_aggregates_hourly")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("SeverityText = 'ERROR'")
		expect(sql).toContain("Body ILIKE '%timeout%'")
	})
})

// ---------------------------------------------------------------------------
// logsListQuery
// ---------------------------------------------------------------------------

describe("logsListQuery", () => {
	it("compiles basic list with all columns", () => {
		const q = logsListQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("Timestamp AS timestamp")
		expect(sql).toContain("SeverityText AS severityText")
		expect(sql).toContain("SeverityNumber AS severityNumber")
		expect(sql).toContain("ServiceName AS serviceName")
		expect(sql).toContain("Body AS body")
		expect(sql).toContain("TraceId AS traceId")
		expect(sql).toContain("SpanId AS spanId")
		expect(sql).toContain("toJSONString(LogAttributes) AS logAttributes")
		expect(sql).toContain("toJSONString(ResourceAttributes) AS resourceAttributes")
		expect(sql).toContain("ORDER BY timestamp DESC")
		expect(sql).toContain("LIMIT 50")
		expect(sql).toContain("FORMAT JSON")
	})

	it("applies cursor pagination", () => {
		const q = logsListQuery({ cursor: "2024-01-01T12:00:00" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("Timestamp < '2024-01-01T12:00:00'")
	})

	it("applies custom limit", () => {
		const q = logsListQuery({ limit: 100 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 100")
	})

	it("applies all filters simultaneously", () => {
		const q = logsListQuery({
			serviceName: "api",
			severity: "ERROR",
			traceId: "trace123",
			spanId: "span456",
			search: "timeout",
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("SeverityText = 'ERROR'")
		expect(sql).toContain("TraceId = 'trace123'")
		expect(sql).toContain("SpanId = 'span456'")
		expect(sql).toContain("Body ILIKE '%timeout%'")
	})

	it("applies minSeverity filter", () => {
		const q = logsListQuery({ minSeverity: 9 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("SeverityNumber >= 9")
	})

	it("gates the heavy column scan on a cheap cutoff subquery", () => {
		const q = logsListQuery({ limit: 100 })
		const { sql } = compileCH(q, baseParams)

		// Outer query keeps the heavy projection.
		expect(sql).toContain("Body AS body")
		expect(sql).toContain("toJSONString(LogAttributes) AS logAttributes")

		// Cutoff subquery reads only Timestamp — no Body, no toJSONString.
		const cutoffMatch = sql.match(/SELECT min\(ts\) FROM \(([\s\S]*?)\)\)/)
		expect(cutoffMatch).not.toBeNull()
		const inner = cutoffMatch![1]!
		expect(inner).toContain("Timestamp AS ts")
		expect(inner).not.toContain("Body")
		expect(inner).not.toContain("toJSONString")
		expect(inner).toContain("ORDER BY ts DESC")
		expect(inner).toContain("LIMIT 100")

		// Outer query gates on the cutoff.
		expect(sql).toContain("Timestamp >= (SELECT min(ts) FROM (")
	})

	it("applies the same filters to both the cutoff and outer stages", () => {
		const q = logsListQuery({ serviceName: "api", severity: "ERROR" })
		const { sql } = compileCH(q, baseParams)
		// Each filter appears twice — once per stage.
		expect(sql.match(/ServiceName = 'api'/g)).toHaveLength(2)
		expect(sql.match(/SeverityText = 'ERROR'/g)).toHaveLength(2)
		expect(sql.match(/OrgId = 'org_1'/g)).toHaveLength(2)
	})
})

// ---------------------------------------------------------------------------
// getLogByKeyQuery
// ---------------------------------------------------------------------------

describe("getLogByKeyQuery", () => {
	const keyParams = { ...baseParams, timestamp: "2024-01-01 12:00:00.123456" }

	it("compiles an exact-match single-log lookup", () => {
		const q = getLogByKeyQuery({ serviceName: "api" })
		const { sql } = compileCH(q, keyParams)
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("Timestamp AS timestamp")
		expect(sql).toContain("toJSONString(LogAttributes) AS logAttributes")
		expect(sql).toContain("Timestamp = '2024-01-01 12:00:00.123456'")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("LIMIT 1")
		expect(sql).toContain("FORMAT JSON")
	})

	it("bounds TimestampTime for partition pruning", () => {
		const q = getLogByKeyQuery({ serviceName: "api" })
		const { sql } = compileCH(q, keyParams)
		expect(sql).toContain("TimestampTime >= '2024-01-01 00:00:00'")
		expect(sql).toContain("TimestampTime <= '2024-01-02 00:00:00'")
	})

	it("applies optional traceId and spanId filters", () => {
		const q = getLogByKeyQuery({ serviceName: "api", traceId: "trace123", spanId: "span456" })
		const { sql } = compileCH(q, keyParams)
		expect(sql).toContain("TraceId = 'trace123'")
		expect(sql).toContain("SpanId = 'span456'")
	})

	it("omits traceId and spanId filters when not provided", () => {
		const q = getLogByKeyQuery({ serviceName: "api" })
		const { sql } = compileCH(q, keyParams)
		expect(sql).not.toContain("TraceId =")
		expect(sql).not.toContain("SpanId =")
	})
})

// ---------------------------------------------------------------------------
// errorRateByServiceQuery
// ---------------------------------------------------------------------------

describe("errorRateByServiceQuery", () => {
	it("uses the hourly aggregate for full interior hours and raw logs for exact edges", () => {
		const q = errorRateByServiceQuery()
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("sum(Count) AS bucketTotalLogs")
		expect(sql).toContain("sumIf(Count, SeverityText IN ('ERROR', 'FATAL')) AS bucketErrorLogs")
		expect(sql).toContain("sum(bucketTotalLogs) AS totalLogs")
		expect(sql).toContain("sum(bucketErrorLogs) AS errorLogs")
		expect(sql).toContain("count() AS bucketTotalLogs")
		expect(sql).toContain("countIf(")
		expect(sql).toContain("IN ('ERROR', 'FATAL')")
		expect(sql).toContain("AS bucketErrorLogs")
		expect(sql).toContain("round(")
		expect(sql).toContain("AS errorRate")
		expect(sql).toContain("GROUP BY serviceName")
		expect(sql).toContain("ORDER BY errorRate DESC")
		expect(sql).toContain("FORMAT JSON")
	})
})

// ---------------------------------------------------------------------------
// logsFacetsQuery
// ---------------------------------------------------------------------------

describe("logsFacetsQuery", () => {
	it("routes to logs_aggregates_hourly with severity/service/deploymentEnv/namespace facets", () => {
		const q = logsFacetsQuery({})
		const { sql } = compileUnion(q, baseParams)
		const unionCount = (sql.match(/UNION ALL/g) || []).length
		expect(unionCount).toBe(3)
		expect(sql).toContain("FROM logs_aggregates_hourly")
		// Pre-aggregated reads — no raw map lookups on the MV path.
		expect(sql).not.toContain("ResourceAttributes")
		expect(sql).toContain("'severity' AS facetType")
		expect(sql).toContain("'service' AS facetType")
		expect(sql).toContain("'deploymentEnv' AS facetType")
		expect(sql).toContain("'namespace' AS facetType")
		expect(sql).toContain("ServiceNamespace AS namespace")
		expect(sql).toContain("sum(Count) AS count")
		// Env facet reads the top-level MV column, not the resource-attr map.
		expect(sql).toContain("DeploymentEnv AS deploymentEnv")
		expect(sql).toContain("ORDER BY count DESC")
	})

	it("filters on Hour instead of the dual Timestamp/TimestampTime predicates", () => {
		const q = logsFacetsQuery({})
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("Hour >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Hour <= '2024-01-02 00:00:00'")
		expect(sql).not.toContain("TimestampTime")
	})

	it("applies optional filters", () => {
		const q = logsFacetsQuery({ serviceName: "api", severity: "ERROR" })
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("SeverityText = 'ERROR'")
	})

	it("falls back to raw `logs` for `contains`-mode environment match", () => {
		const q = logsFacetsQuery({
			environments: ["prod"],
			matchModes: { deploymentEnv: "contains" },
		})
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("FROM logs")
		expect(sql).not.toContain("logs_aggregates_hourly")
		expect(sql).toContain("positionCaseInsensitive(ResourceAttributes['deployment.environment'], 'prod')")
	})

	it("compiles only the requested branch when facet is set", () => {
		const q = logsFacetsQuery({}, "severity")
		const { sql } = compileUnion(q, baseParams)
		expect(sql).not.toContain("UNION ALL")
		expect(sql).toContain("FROM logs_aggregates_hourly")
		expect(sql).toContain("'severity' AS facetType")
		expect(sql).not.toContain("'service' AS facetType")
		// Same outer shape as the full union: count-desc, limit 500.
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 500")
	})

	it("facet scoping follows the raw-`logs` fallback path", () => {
		const q = logsFacetsQuery({ environments: ["prod"], matchModes: { deploymentEnv: "contains" } }, "severity")
		const { sql } = compileUnion(q, baseParams)
		expect(sql).not.toContain("UNION ALL")
		expect(sql).toContain("FROM logs")
		expect(sql).toContain("'severity' AS facetType")
		expect(sql).not.toContain("'namespace' AS facetType")
	})
})

// ---------------------------------------------------------------------------
// environments filter (applies to all logs queries via ResourceAttributes)
// ---------------------------------------------------------------------------

describe("environments filter", () => {
	it("logsListQuery filters by a single environment", () => {
		const q = logsListQuery({ environments: ["production"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production')")
	})

	it("logsListQuery filters by multiple environments", () => {
		const q = logsListQuery({ environments: ["production", "staging"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production', 'staging')")
	})

	it("logsListQuery uses positionCaseInsensitive for single-value contains mode", () => {
		const q = logsListQuery({ environments: ["prod"], matchModes: { deploymentEnv: "contains" } })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("positionCaseInsensitive(ResourceAttributes['deployment.environment'], 'prod')")
	})

	it("logsCountQuery applies environments filter", () => {
		const q = logsCountQuery({ environments: ["production"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production')")
	})

	it("logsTimeseriesQuery applies environments filter", () => {
		const q = logsTimeseriesQuery({ environments: ["production"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production')")
	})

	it("logsFacetsQuery applies environments filter to all branches via the MV column", () => {
		const q = logsFacetsQuery({ environments: ["production"] })
		const { sql } = compileUnion(q, baseParams)
		expect(sql).toContain("FROM logs_aggregates_hourly")
		const matches = sql.match(/DeploymentEnv IN \('production'\)/g) || []
		expect(matches.length).toBe(4)
		expect(sql).not.toContain("ResourceAttributes")
	})
})
