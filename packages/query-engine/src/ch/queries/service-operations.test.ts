import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { compileCH } from "@maple-dev/clickhouse-builder"
import { NORMALIZED_SPAN_NAME_SQL } from "@maple/domain/tinybird/span-display-name"
import {
	serviceOperationsSummaryQuery,
	serviceOperationsSummaryRawQuery,
	serviceOperationsSummaryRowSchema,
	serviceOperationsTimeseriesQuery,
	serviceOperationsTimeseriesRawQuery,
	serviceOperationsTimeseriesRowSchema,
} from "./service-operations"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

describe("serviceOperationsSummaryQuery", () => {
	it("retains the previous raw implementations as rollout rollback paths", () => {
		const summary = compileCH(serviceOperationsSummaryRawQuery({ serviceName: "api" }), baseParams)
		const timeseries = compileCH(
			serviceOperationsTimeseriesRawQuery({ serviceName: "api", spanNames: ["GET /users"] }),
			{ ...baseParams, bucketSeconds: 300 },
		)
		expect(summary.sql).toContain("FROM traces")
		expect(summary.sql).not.toContain("service_operations_minutely")
		expect(timeseries.sql).toContain("FROM traces")
		expect(timeseries.sql).not.toContain("service_operations_minutely")
	})

	it("combines raw edge fragments with complete rollup minutes", () => {
		const q = serviceOperationsSummaryQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("FROM service_operations_minutely")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("Timestamp >= '2024-01-01 00:00:00'")
		expect(sql).toContain("Minute >= if(toDateTime('2024-01-01 00:00:00')")
		expect(sql).toContain("Minute < toStartOfMinute(toDateTime('2024-01-02 00:00:00'))")
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
		expect(sql).toContain(`${NORMALIZED_SPAN_NAME_SQL} AS bSpanName`)
	})

	it("merges exact, sampling-weighted, error, duration, and t-digest state", () => {
		const q = serviceOperationsSummaryQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("sum(SampleRate) AS bEstimatedSpanCount")
		expect(sql).toContain("sumIf(SampleRate, StatusCode = 'Error') AS bEstimatedErrorCount")
		expect(sql).toContain("countIf(StatusCode = 'Error') AS bErrorCount")
		expect(sql).toContain("quantilesTDigestState(0.5, 0.95)(Duration)")
		expect(sql).toContain("quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles)")
		expect(sql).toContain(
			"if(sum(bEstimatedSpanCount) > 0, sum(bEstimatedErrorCount) / sum(bEstimatedSpanCount), 0) AS errorRate",
		)
		expect(sql).toContain("quantilesTDigestMerge(0.5, 0.95)(bDurationQuantiles), 1")
		expect(sql).toContain("quantilesTDigestMerge(0.5, 0.95)(bDurationQuantiles), 2")
	})

	it("applies environment filter via ResourceAttributes", () => {
		const q = serviceOperationsSummaryQuery({ serviceName: "api", environments: ["production"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production')")
		expect(sql).toContain("DeploymentEnv IN ('production')")
	})

	it("preserves internal operations by applying no SpanKind filter", () => {
		const q = serviceOperationsSummaryQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).not.toContain("SpanKind IN")
	})

	it("respects a custom limit", () => {
		const q = serviceOperationsSummaryQuery({ serviceName: "api", limit: 5 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 5")
	})

	it("uses disjoint raw and rollup boundaries for partial edge minutes", () => {
		const q = serviceOperationsSummaryQuery({ serviceName: "api" })
		const { sql } = compileCH(q, {
			orgId: "org_1",
			startTime: "2024-01-01 00:00:30",
			endTime: "2024-01-01 00:02:15",
		})
		expect(sql).toContain("Timestamp < if(toDateTime('2024-01-01 00:00:30') = toStartOfMinute")
		expect(sql).toContain("Timestamp >= toStartOfMinute(toDateTime('2024-01-01 00:02:15'))")
		expect(sql).toContain("Minute >= if(toDateTime('2024-01-01 00:00:30') = toStartOfMinute")
		expect(sql).toContain("Minute < toStartOfMinute(toDateTime('2024-01-01 00:02:15'))")
	})

	it("keeps sub-minute and empty windows valid", () => {
		for (const [startTime, endTime] of [
			["2024-01-01 00:00:10", "2024-01-01 00:00:40"],
			["2024-01-01 00:00:10", "2024-01-01 00:00:10"],
		] as const) {
			const { sql } = compileCH(serviceOperationsSummaryQuery({ serviceName: "api" }), {
				orgId: "org_1",
				startTime,
				endTime,
			})
			expect(sql).toContain("UNION ALL")
			expect(sql).toContain(`Timestamp >= '${startTime}'`)
			expect(sql).toContain(`Timestamp <= '${endTime}'`)
		}
	})
})

describe("serviceOperationsTimeseriesQuery", () => {
	it("buckets sampling-weighted counts per operation", () => {
		const q = serviceOperationsTimeseriesQuery({ serviceName: "api", spanNames: ["GET /users"] })
		const { sql } = compileCH(q, { ...baseParams, bucketSeconds: 300 })
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("FROM service_operations_minutely")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("toStartOfInterval(Timestamp, INTERVAL 300 SECOND)")
		expect(sql).toContain("toStartOfInterval(Minute, INTERVAL 300 SECOND)")
		expect(sql).toContain("sum(SampleRate) AS count")
		expect(sql).toContain("sum(EstimatedSpanCount) AS count")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("GROUP BY bucket, spanName")
		expect(sql).toContain("ORDER BY bucket ASC")
	})

	it("matches rollup rows directly on normalized SpanName", () => {
		const q = serviceOperationsTimeseriesQuery({ serviceName: "api", spanNames: ["GET /users"] })
		const { sql } = compileCH(q, { ...baseParams, bucketSeconds: 300 })
		expect(sql).toContain("SpanName IN ('GET /users')")
		expect(sql).not.toContain("SpanName IN ('GET /users') OR")
		// The display-name rewrite remains only for the two raw edge fragments.
		expect(sql).toContain("http.route")
	})
})

describe("hybrid minute coverage", () => {
	const minute = (value: string) => Math.floor(Date.parse(value) / 60_000) * 60_000

	it("assigns every requested timestamp to exactly one branch", () => {
		const start = Date.parse("2024-01-01T00:00:30Z")
		const end = Date.parse("2024-01-01T00:03:15Z")
		const firstFullMinute = minute(new Date(start).toISOString()) + 60_000
		const endMinute = minute(new Date(end).toISOString())
		const timestamps = [
			start,
			Date.parse("2024-01-01T00:00:59Z"),
			Date.parse("2024-01-01T00:01:00Z"),
			Date.parse("2024-01-01T00:02:59Z"),
			Date.parse("2024-01-01T00:03:00Z"),
			end,
		]

		for (const timestamp of timestamps) {
			const rawEdge = timestamp < firstFullMinute || timestamp >= endMinute
			const rollupInterior =
				minute(new Date(timestamp).toISOString()) >= firstFullMinute &&
				minute(new Date(timestamp).toISOString()) < endMinute
			expect(Number(rawEdge) + Number(rollupInterior)).toBe(1)
		}
	})

	it("keeps every timestamp raw for a sub-minute window", () => {
		const start = Date.parse("2024-01-01T00:00:10Z")
		const end = Date.parse("2024-01-01T00:00:40Z")
		const firstFullMinute = minute(new Date(start).toISOString()) + 60_000
		const endMinute = minute(new Date(end).toISOString())
		for (const timestamp of [start, Date.parse("2024-01-01T00:00:25Z"), end]) {
			expect(timestamp < firstFullMinute || timestamp >= endMinute).toBe(true)
			expect(
				minute(new Date(timestamp).toISOString()) >= firstFullMinute &&
					minute(new Date(timestamp).toISOString()) < endMinute,
			).toBe(false)
		}
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
