import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	serviceOperationsSummaryQuery,
	serviceOperationsSummaryRowSchema,
	serviceOperationsTimeseriesQuery,
	serviceOperationsTimeseriesRowSchema,
} from "./service-operations"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

describe("serviceOperationsSummaryQuery", () => {
	it("compiles an OrgId-scoped per-operation aggregation over raw traces", () => {
		const q = serviceOperationsSummaryQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
		expect(sql).toContain("GROUP BY spanName")
		expect(sql).toContain("ORDER BY estimatedSpanCount DESC")
		expect(sql).toContain("LIMIT 25")
		expect(sql).toContain("FORMAT JSON")
	})

	it("keys operations on the HTTP display span name", () => {
		const q = serviceOperationsSummaryQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		// httpDisplaySpanName rewrites "http.server GET" + route → "GET /api/users"
		expect(sql).toContain("http.route")
		expect(sql).toContain("url.path")
		expect(sql).toContain("AS spanName")
	})

	it("weights counts and error rate by SampleRate", () => {
		const q = serviceOperationsSummaryQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("sum(SampleRate) AS estimatedSpanCount")
		expect(sql).toContain("sumIf(SampleRate, StatusCode = 'Error') AS estimatedErrorCount")
		expect(sql).toContain("countIf(StatusCode = 'Error') AS errorCount")
		expect(sql).toContain(
			"if(sum(SampleRate) > 0, sumIf(SampleRate, StatusCode = 'Error') / sum(SampleRate), 0) AS errorRate",
		)
		expect(sql).toContain("quantile(0.5)(Duration) / 1000000 AS p50DurationMs")
		expect(sql).toContain("quantile(0.95)(Duration) / 1000000 AS p95DurationMs")
	})

	it("applies environment filter via ResourceAttributes", () => {
		const q = serviceOperationsSummaryQuery({ serviceName: "api", environments: ["production"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production')")
	})

	it("respects a custom limit", () => {
		const q = serviceOperationsSummaryQuery({ serviceName: "api", limit: 5 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 5")
	})
})

describe("serviceOperationsTimeseriesQuery", () => {
	it("buckets sampling-weighted counts per operation", () => {
		const q = serviceOperationsTimeseriesQuery({ serviceName: "api", spanNames: ["GET /users"] })
		const { sql } = compileCH(q, { ...baseParams, bucketSeconds: 300 })
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("toStartOfInterval(Timestamp, INTERVAL 300 SECOND)")
		expect(sql).toContain("sum(SampleRate) AS count")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("GROUP BY bucket, spanName")
		expect(sql).toContain("ORDER BY bucket ASC")
	})

	it("matches operations on either the raw or display span name", () => {
		const q = serviceOperationsTimeseriesQuery({ serviceName: "api", spanNames: ["GET /users"] })
		const { sql } = compileCH(q, { ...baseParams, bucketSeconds: 300 })
		expect(sql).toContain("SpanName IN ('GET /users')")
		// The display-name rewrite must appear in the IN matcher too.
		expect(sql).toContain("http.route")
	})
})

describe("row schemas (BYO-CH UInt64-as-string)", () => {
	it("decodes numeric strings in summary rows", () => {
		const decoded = Schema.decodeUnknownSync(serviceOperationsSummaryRowSchema)({
			spanName: "GET /users",
			spanCount: "1200",
			estimatedSpanCount: 1200,
			errorCount: "3",
			estimatedErrorCount: 3,
			errorRate: "0.0025",
			avgDurationMs: 12.5,
			p50DurationMs: "10",
			p95DurationMs: "42",
		})
		expect(decoded.spanCount).toBe(1200)
		expect(decoded.errorRate).toBeCloseTo(0.0025)
		expect(decoded.p95DurationMs).toBe(42)
	})

	it("decodes numeric strings in timeseries rows", () => {
		const decoded = Schema.decodeUnknownSync(serviceOperationsTimeseriesRowSchema)({
			bucket: "2024-01-01 00:00:00",
			spanName: "GET /users",
			count: "17",
		})
		expect(decoded.count).toBe(17)
	})
})
