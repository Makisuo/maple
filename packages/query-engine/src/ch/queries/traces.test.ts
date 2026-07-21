import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	slowTracesQuery,
	spanSearchQuery,
	traceSummariesQuery,
	tracesListQuery,
	tracesRootListQuery,
} from "./traces"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
	bucketSeconds: 3600,
}

describe("traceSummariesQuery", () => {
	it("matches any span through a filtered semi-join and paginates root summaries deterministically", () => {
		const { sql } = compileCH(
			traceSummariesQuery({
				serviceName: "api",
				hasError: true,
				limit: 21,
				cursor: { timestamp: "2024-01-01 12:00:00", traceId: "trace123" },
			}),
			baseParams,
		)
		expect(sql).toContain("FROM trace_list_mv")
		expect(sql.match(/OrgId = 'org_1'/g)).toHaveLength(2)
		expect(sql.match(/Timestamp >= '2024-01-01 00:00:00'/g)).toHaveLength(2)
		expect(sql.match(/Timestamp <= '2024-01-02 00:00:00'/g)).toHaveLength(2)
		expect(sql).toMatch(/TraceId IN \(SELECT\s+TraceId AS traceId/)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("StatusCode = 'Error'")
		expect(sql).toContain("GROUP BY traceId")
		expect(sql).toContain("ORDER BY startTime DESC, traceId DESC")
		expect(sql).toContain("LIMIT 21")
		expect(sql).toContain("Timestamp < '2024-01-01 12:00:00'")
		expect(sql).toContain("TraceId < 'trace123'")
	})

	it("restricts the matching subquery to root spans when spanScope=root", () => {
		const { sql } = compileCH(traceSummariesQuery({ serviceName: "api", spanScope: "root" }), baseParams)
		expect(sql).toMatch(/TraceId IN \(SELECT\s+TraceId AS traceId/)
		expect(sql).toContain("SpanKind IN ('Server', 'Consumer')")
	})
})

// ---------------------------------------------------------------------------
// tracesListQuery
// ---------------------------------------------------------------------------

describe("tracesListQuery", () => {
	it("compiles basic list with all columns", () => {
		const q = tracesListQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("TraceId AS traceId")
		expect(sql).toContain("Timestamp AS timestamp")
		expect(sql).toContain("SpanId AS spanId")
		expect(sql).toContain("ServiceName AS serviceName")
		expect(sql).toContain("SpanName AS spanName")
		expect(sql).toContain("Duration / 1000000 AS durationMs")
		expect(sql).toContain("StatusCode AS statusCode")
		expect(sql).toContain("SpanKind AS spanKind")
		expect(sql).toContain("AS hasError")
		expect(sql).toContain("SpanAttributes AS spanAttributes")
		expect(sql).toContain("ResourceAttributes AS resourceAttributes")
		expect(sql).toContain("ORDER BY timestamp DESC")
		expect(sql).toContain("LIMIT 25")
		expect(sql).toContain("FORMAT JSON")
	})

	it("applies cursor pagination", () => {
		const q = tracesListQuery({ cursor: "2024-01-01T12:00:00" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("Timestamp < '2024-01-01T12:00:00'")
	})

	it("applies custom limit", () => {
		const q = tracesListQuery({ limit: 100 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 100")
	})

	it("applies offset", () => {
		const q = tracesListQuery({ limit: 50, offset: 20 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 50")
		expect(sql).toContain("OFFSET 20")
	})

	it("applies all filters simultaneously", () => {
		const q = tracesListQuery({
			serviceName: "api",
			spanName: "GET /users",
			errorsOnly: true,
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("SpanName = 'GET /users'")
		expect(sql).toContain("StatusCode = 'Error'")
	})

	it("projects only requested attribute keys when columns are specified", () => {
		const q = tracesListQuery({
			columns: ["spanAttributes.http.method", "resourceAttributes.service.version"],
		})
		const { sql } = compileCH(q, baseParams)
		// Projected map literal uses map(...) instead of the bare column.
		expect(sql).toContain("'http.method'")
		expect(sql).toContain("'service.version'")
	})

	it("gates the heavy column scan on a cheap cutoff subquery", () => {
		const q = tracesListQuery({ limit: 100 })
		const { sql } = compileCH(q, baseParams)

		// Outer query keeps the heavy Map columns.
		expect(sql).toContain("SpanAttributes AS spanAttributes")
		expect(sql).toContain("ResourceAttributes AS resourceAttributes")

		// Cutoff subquery reads only Timestamp — no Map columns, no Duration math.
		const cutoffMatch = sql.match(/SELECT min\(ts\) FROM \(([\s\S]*?)\)\)/)
		expect(cutoffMatch).not.toBeNull()
		const inner = cutoffMatch![1]!
		expect(inner).toContain("Timestamp AS ts")
		expect(inner).not.toContain("SpanAttributes")
		expect(inner).not.toContain("ResourceAttributes")
		expect(inner).not.toContain("Duration")
		expect(inner).toContain("ORDER BY ts DESC")
		expect(inner).toContain("LIMIT 100")

		// Outer query gates on the cutoff.
		expect(sql).toContain("Timestamp >= (SELECT min(ts) FROM (")
	})

	it("extends the cutoff limit by offset so the cutoff covers all skipped rows", () => {
		const q = tracesListQuery({ limit: 25, offset: 100 })
		const { sql } = compileCH(q, baseParams)
		const cutoffMatch = sql.match(/SELECT min\(ts\) FROM \(([\s\S]*?)\)\)/)
		expect(cutoffMatch).not.toBeNull()
		const inner = cutoffMatch![1]!
		// Stage 1 must look at limit+offset rows so the cutoff isn't above the
		// rows the outer OFFSET will skip past.
		expect(inner).toContain("LIMIT 125")
	})

	it("applies the same filters to both the cutoff and outer stages", () => {
		const q = tracesListQuery({ serviceName: "api", errorsOnly: true })
		const { sql } = compileCH(q, baseParams)
		// Each filter appears twice — once per stage.
		expect(sql.match(/ServiceName = 'api'/g)).toHaveLength(2)
		expect(sql.match(/OrgId = 'org_1'/g)).toHaveLength(2)
		// `StatusCode = 'Error'` shows up in the WHERE of both stages (errorsOnly)
		// plus once in the outer SELECT's `hasError` expression — 3 total.
		expect(sql.match(/StatusCode = 'Error'/g)).toHaveLength(3)
	})

	it("includes the cursor in the cutoff subquery so pagination narrows the cheap scan too", () => {
		const q = tracesListQuery({ cursor: "2024-01-01T12:00:00" })
		const { sql } = compileCH(q, baseParams)
		// Cursor predicate applies in both stages.
		expect(sql.match(/Timestamp < '2024-01-01T12:00:00'/g)).toHaveLength(2)
	})
})

// ---------------------------------------------------------------------------
// tracesRootListQuery
// ---------------------------------------------------------------------------

describe("tracesRootListQuery", () => {
	it("compiles basic root list with all columns", () => {
		const q = tracesRootListQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("TraceId AS traceId")
		expect(sql).toContain("Timestamp AS startTime")
		expect(sql).toContain("Timestamp AS endTime")
		expect(sql).toContain("AS durationMicros")
		expect(sql).toContain("AS spanCount")
		expect(sql).toContain("AS services")
		expect(sql).toContain("SpanName AS rootSpanName")
		expect(sql).toContain("SpanKind AS rootSpanKind")
		expect(sql).toContain("StatusCode AS rootSpanStatusCode")
		expect(sql).toContain("'http.method'")
		expect(sql).toContain("'http.route'")
		expect(sql).toContain("'http.status_code'")
		expect(sql).toContain("AS rootSpanAttributes")
		expect(sql).toContain("AS hasError")
		expect(sql).toContain("ORDER BY startTime DESC")
		expect(sql).toContain("LIMIT 25")
		expect(sql).toContain("FORMAT JSON")
	})

	it("projects the URL/host keys into rootSpanAttributes for client-span labels", () => {
		const q = tracesRootListQuery({})
		const { sql } = compileCH(q, baseParams)
		// These keys (omitted by the flat rootHttp* columns) let getHttpInfo build
		// a client destination instead of falling back to "http.client GET".
		expect(sql).toContain("'url.full'")
		expect(sql).toContain("'server.address'")
		expect(sql).toContain("'url.path'")
	})

	it("applies rootOnly filter (SpanKind in Server/Consumer OR ParentSpanId='')", () => {
		const q = tracesRootListQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''")
	})

	it("applies cursor pagination", () => {
		const q = tracesRootListQuery({ cursor: "2024-01-01T12:00:00" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("Timestamp < '2024-01-01T12:00:00'")
	})

	it("applies offset", () => {
		const q = tracesRootListQuery({ limit: 50, offset: 20 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 50")
		expect(sql).toContain("OFFSET 20")
	})

	it("gates the heavy column scan on a cheap cutoff subquery", () => {
		const q = tracesRootListQuery({ limit: 100 })
		const { sql } = compileCH(q, baseParams)

		// Outer query keeps the heavy Map lookups.
		expect(sql).toContain("'http.method'")
		expect(sql).toContain("'http.route'")

		// Cutoff subquery reads only Timestamp.
		const cutoffMatch = sql.match(/SELECT min\(ts\) FROM \(([\s\S]*?)\)\)/)
		expect(cutoffMatch).not.toBeNull()
		const inner = cutoffMatch![1]!
		expect(inner).toContain("Timestamp AS ts")
		expect(inner).not.toContain("SpanAttributes")
		expect(inner).not.toContain("Duration")
		expect(inner).toContain("ORDER BY ts DESC")
		expect(inner).toContain("LIMIT 100")

		// The rootOnly predicate still applies inside the cheap scan so
		// the cutoff matches the same population as the outer query.
		expect(inner).toContain("SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''")

		// Outer query gates on the cutoff.
		expect(sql).toContain("Timestamp >= (SELECT min(ts) FROM (")
	})

	it("extends the cutoff limit by offset", () => {
		const q = tracesRootListQuery({ limit: 25, offset: 75 })
		const { sql } = compileCH(q, baseParams)
		const cutoffMatch = sql.match(/SELECT min\(ts\) FROM \(([\s\S]*?)\)\)/)
		expect(cutoffMatch).not.toBeNull()
		const inner = cutoffMatch![1]!
		expect(inner).toContain("LIMIT 100")
	})

	it("applies the same filters to both stages", () => {
		const q = tracesRootListQuery({ serviceName: "api", errorsOnly: true })
		const { sql } = compileCH(q, baseParams)
		expect(sql.match(/ServiceName = 'api'/g)).toHaveLength(2)
		expect(sql.match(/OrgId = 'org_1'/g)).toHaveLength(2)
		// `StatusCode = 'Error'` shows up in the WHERE of both stages (errorsOnly)
		// plus once in the outer SELECT's `hasError` expression — 3 total.
		expect(sql.match(/StatusCode = 'Error'/g)).toHaveLength(3)
	})
})

// ---------------------------------------------------------------------------
// slowTracesQuery
// ---------------------------------------------------------------------------

describe("slowTracesQuery", () => {
	it("reads slow root spans from the pre-extracted trace list MV", () => {
		const q = slowTracesQuery({ service: "api", environment: "prod", limit: 5 })
		const { sql } = compileCH(q, baseParams)

		expect(sql).toContain("FROM trace_list_mv")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("DeploymentEnv = 'prod'")
		expect(sql).toContain("ORDER BY durationMs DESC")
		expect(sql).toContain("LIMIT 5")
		expect(sql).not.toContain("ParentSpanId")
		expect(sql).not.toContain("ResourceAttributes")
	})
})

// ---------------------------------------------------------------------------
// spanSearchQuery
// ---------------------------------------------------------------------------

describe("spanSearchQuery", () => {
	it("uses the trace-detail table when a trace id is provided", () => {
		const q = spanSearchQuery({ traceId: "trace_123", spanName: "GET /users", limit: 50, offset: 10 })
		const { sql } = compileCH(q, baseParams)

		expect(sql).toContain("FROM trace_detail_spans")
		expect(sql).toContain("TraceId = 'trace_123'")
		expect(sql).toContain("SpanName = 'GET /users'")
		expect(sql).toContain("LIMIT 50")
		expect(sql).toContain("OFFSET 10")
	})

	it("keeps broad span searches on the raw traces table", () => {
		const q = spanSearchQuery({ spanName: "GET /users", limit: 20 })
		const { sql } = compileCH(q, baseParams)

		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("FROM trace_detail_spans")
		expect(sql).toContain("SpanName = 'GET /users'")
	})
})
