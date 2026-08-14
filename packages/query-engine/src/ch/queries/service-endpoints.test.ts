import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	HTTP_METHODS,
	isHttpApiService,
	serviceApiProfileQuery,
	serviceApiProfileRowSchema,
	serviceEndpointsSummaryQuery,
	serviceEndpointsSummaryRawQuery,
	serviceEndpointsSummaryRowSchema,
} from "./service-endpoints"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
}

describe("serviceApiProfileQuery", () => {
	it("counts HTTP server spans, entry spans, and distinct endpoints in one scan", () => {
		const { sql } = compileCH(serviceApiProfileQuery({ serviceName: "api" }), baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ServiceName = 'api'")
		expect(sql).toContain("AS httpServerSpans")
		expect(sql).toContain("countIf(IsEntryPoint = 1) AS entrySpans")
		expect(sql).toContain("AS distinctEndpoints")
		expect(sql).toContain("uniqIf(")
	})

	it("detects HTTP server spans from route, url.path, and the pre-1.0 http.target", () => {
		const { sql } = compileCH(serviceApiProfileQuery({ serviceName: "api" }), baseParams)
		expect(sql).toContain("SpanKind = 'Server'")
		expect(sql).toContain("SpanAttributes['http.route'] != ''")
		expect(sql).toContain("SpanAttributes['url.path'] != ''")
		expect(sql).toContain("SpanAttributes['http.target'] != ''")
	})

	it("applies the environment filter", () => {
		const { sql } = compileCH(
			serviceApiProfileQuery({ serviceName: "api", environments: ["production"] }),
			baseParams,
		)
		expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production')")
	})

	it("decodes JSON-string UInt64 counts from a BYO ClickHouse gateway", () => {
		const decoded = Schema.decodeUnknownSync(serviceApiProfileRowSchema)({
			httpServerSpans: "9007199254740",
			entrySpans: "12",
			distinctEndpoints: "3",
		})
		expect(decoded).toEqual({ httpServerSpans: 9007199254740, entrySpans: 12, distinctEndpoints: 3 })
	})
})

describe("isHttpApiService", () => {
	const profile = (over: Partial<Parameters<typeof isHttpApiService>[0]>) =>
		isHttpApiService({ httpServerSpans: 100, entrySpans: 100, distinctEndpoints: 5, ...over })

	it("accepts a service with endpoints and enough server traffic", () => {
		expect(profile({})).toBe(true)
	})

	it("accepts a mostly-async service that also exposes a single endpoint", () => {
		// No ratio gate: a worker with a health endpoint still gets the tab.
		expect(profile({ httpServerSpans: 20, entrySpans: 100_000, distinctEndpoints: 1 })).toBe(true)
	})

	it("rejects a service with no HTTP server spans at all", () => {
		expect(profile({ httpServerSpans: 0, distinctEndpoints: 0 })).toBe(false)
	})

	it("rejects a handful of stray probe requests below the span floor", () => {
		expect(profile({ httpServerSpans: 19, distinctEndpoints: 1 })).toBe(false)
	})
})

describe("serviceEndpointsSummaryQuery", () => {
	it("combines raw edges, minutely boundary hours, and complete hourly interiors", () => {
		const { sql } = compileCH(serviceEndpointsSummaryQuery({ serviceName: "api" }), baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).toContain("UNION ALL")
		expect(sql).toContain("FROM service_operations_minutely")
		expect(sql).toContain("FROM service_operations_hourly")
		expect(sql).toContain("ORDER BY estimatedSpanCount DESC")
		expect(sql).toContain("LIMIT 25")
		expect(sql).toContain("FORMAT JSON")
	})

	it("filters raw edges on SpanKind, and rollup interiors on the display-name shape", () => {
		const { sql } = compileCH(serviceEndpointsSummaryQuery({ serviceName: "api" }), baseParams)
		// Raw rows have the columns the rollups dropped, so they get the accurate filter.
		expect(sql).toContain("SpanKind = 'Server'")
		// The rollups only kept the normalized name, so they match its shape.
		expect(sql).toContain(`match(SpanName, '^(${HTTP_METHODS.join("|")}) /')`)
	})

	it("splits the fused display name into method and route server-side", () => {
		const { sql } = compileCH(serviceEndpointsSummaryQuery({ serviceName: "api" }), baseParams)
		expect(sql).toContain("extract(bSpanName, '^([A-Z]+) ') AS method")
		expect(sql).toContain("extract(bSpanName, '^[A-Z]+ (.*)$') AS route")
		// The fused name survives — it, not `route`, is the /traces filter key.
		expect(sql).toContain("AS spanName")
	})

	it("carries p99 through both t-digest states", () => {
		const { sql } = compileCH(serviceEndpointsSummaryQuery({ serviceName: "api" }), baseParams)
		expect(sql).toContain("quantilesTDigestState(0.5, 0.95, 0.99)(Duration)")
		expect(sql).toContain("quantilesTDigestMergeState(0.5, 0.95, 0.99)(DurationQuantiles)")
		expect(sql).toContain("quantilesTDigestMerge(0.5, 0.95, 0.99)(bDurationQuantiles), 3")
	})

	it("applies the environment filter to raw and rollup fragments alike", () => {
		const { sql } = compileCH(
			serviceEndpointsSummaryQuery({ serviceName: "api", environments: ["production"] }),
			baseParams,
		)
		expect(sql).toContain("ResourceAttributes['deployment.environment'] IN ('production')")
		expect(sql).toContain("DeploymentEnv IN ('production')")
	})

	it("respects a custom limit", () => {
		const { sql } = compileCH(serviceEndpointsSummaryQuery({ serviceName: "api", limit: 5 }), baseParams)
		expect(sql).toContain("LIMIT 5")
	})
})

describe("serviceEndpointsSummaryRawQuery", () => {
	it("reads only raw traces, for clusters missing the rollup tables", () => {
		const { sql } = compileCH(serviceEndpointsSummaryRawQuery({ serviceName: "api" }), baseParams)
		expect(sql).toContain("FROM traces")
		expect(sql).not.toContain("service_operations_minutely")
		expect(sql).not.toContain("service_operations_hourly")
		expect(sql).toContain("SpanKind = 'Server'")
		expect(sql).toContain("quantile(0.99)(Duration)")
	})

	it("returns the same row shape as the rollup query", () => {
		const row = {
			spanName: "GET /api/users",
			method: "GET",
			route: "/api/users",
			spanCount: "10",
			estimatedSpanCount: "100",
			errorCount: "1",
			estimatedErrorCount: "10",
			errorRate: 0.1,
			avgDurationMs: 12.5,
			p50DurationMs: 10,
			p95DurationMs: 40,
			p99DurationMs: 90,
		}
		const decoded = Schema.decodeUnknownSync(serviceEndpointsSummaryRowSchema)(row)
		expect(decoded.spanCount).toBe(10)
		expect(decoded.method).toBe("GET")
		expect(decoded.route).toBe("/api/users")
	})
})
