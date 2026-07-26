import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileCH, compileUnion, type CompiledQuery } from "@maple-dev/clickhouse-builder"
import {
	CLOUDFLARE_BREAKDOWN_DIMENSIONS,
	CLOUDFLARE_BREAKDOWN_OTHER_KEY,
	cloudflareBreakdownMetrics,
	cloudflareZoneBreakdownCoverageRowSchema,
	cloudflareZoneBreakdownCoverageSQL,
	cloudflareZoneBreakdownTimeseriesRowSchema,
	cloudflareZoneBreakdownTimeseriesSQL,
	cloudflareZoneBreakdownTotalsRowSchema,
	cloudflareZoneBreakdownTotalsSQL,
	cloudflareZoneFacetsQuery,
} from "./cloudflare-infra-breakdowns"

const zoneParams = {
	orgId: "org_1",
	serviceName: "cloudflare/example.com",
	startTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}
const timeseriesParams = { ...zoneParams, bucketSeconds: 300 }

describe("cloudflareZoneBreakdownTotalsSQL", () => {
	it("reads the path family and ranks by requests", () => {
		const { sql } = compileCH(cloudflareZoneBreakdownTotalsSQL("path"), zoneParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("ServiceName = 'cloudflare/example.com'")
		expect(sql).toContain(
			"MetricName IN ('cloudflare.http.requests.by_path', 'cloudflare.http.errors.by_path', 'cloudflare.http.bytes.by_path')",
		)
		expect(sql).toContain("url.path']")
		expect(sql).toContain("GROUP BY key")
		expect(sql).toContain("ORDER BY requests DESC")
		expect(sql).toContain("LIMIT 100")
	})

	it("derives 5xx from the status class when a family has no dedicated errors metric", () => {
		// The main cube carries http.status_class on the same rows; by_country does not carry it at all.
		const host = compileCH(cloudflareZoneBreakdownTotalsSQL("host"), zoneParams).sql
		expect(host).toContain("http.status_class'] = '5xx'")
		const country = compileCH(cloudflareZoneBreakdownTotalsSQL("country"), zoneParams).sql
		expect(country).not.toContain("http.status_class")
	})

	it("keeps the row shape uniform by emitting literal zeros for absent measures", () => {
		// `by_client` has neither an errors nor a bytes metric, so both columns must still exist.
		const { sql } = compileCH(cloudflareZoneBreakdownTotalsSQL("method"), zoneParams).valueOf() as {
			sql: string
		}
		expect(sql).toContain("AS errors5xx")
		expect(sql).toContain("AS bytes")
		expect(sql).toContain("MetricName IN ('cloudflare.http.requests.by_client')")
	})

	it("groups method, protocol and device off the one shared series", () => {
		for (const [dimension, attr] of [
			["method", "http.request.method"],
			["protocol", "network.protocol.version"],
			["deviceType", "cloudflare.device.type"],
		] as const) {
			const { sql } = compileCH(cloudflareZoneBreakdownTotalsSQL(dimension), zoneParams)
			expect(sql).toContain(`${attr}']`)
			expect(sql).toContain("cloudflare.http.requests.by_client")
		}
	})

	it("groups hosts through the transitional coalesce", () => {
		const { sql } = compileCH(cloudflareZoneBreakdownTotalsSQL("host"), zoneParams)
		expect(sql).toContain("server.address']")
		expect(sql).toContain("http.host']")
	})

	it("compiles every registered dimension", () => {
		for (const dimension of CLOUDFLARE_BREAKDOWN_DIMENSIONS) {
			const { sql } = compileCH(cloudflareZoneBreakdownTotalsSQL(dimension), zoneParams)
			expect(sql).toContain("GROUP BY key")
			expect(cloudflareBreakdownMetrics(dimension).length).toBeGreaterThan(0)
		}
	})
})

describe("cloudflareZoneBreakdownTimeseriesSQL", () => {
	it("buckets a single requests metric per dimension value", () => {
		const { sql } = compileCH(cloudflareZoneBreakdownTimeseriesSQL("country"), timeseriesParams)
		expect(sql).toContain("toStartOfInterval")
		expect(sql).toContain("MetricName = 'cloudflare.http.requests.by_country'")
		expect(sql).toContain("geo.country_iso_code']")
		expect(sql).toContain("GROUP BY bucket, key")
		expect(sql).toContain("ORDER BY bucket ASC, key ASC")
	})

	it("folds every key outside topKeys into the shared `other` bucket", () => {
		// Without this the grouping is unbounded: a zone taking scanner traffic emits a distinct
		// path per probe, and the chart gets one <Area> and one legend chip per key.
		const { sql } = compileCH(
			cloudflareZoneBreakdownTimeseriesSQL("path", {}, ["/api/users", "/health"]),
			timeseriesParams,
		)
		expect(sql).toContain("IN ('/api/users', '/health')")
		expect(sql).toContain(`'${CLOUDFLARE_BREAKDOWN_OTHER_KEY}'`)
		expect(sql).toContain("if(")
		// The fold lives in the projection, so every row still contributes to some series.
		expect(sql).toContain("GROUP BY bucket, key")
	})

	it("escapes topKeys rather than interpolating them raw", () => {
		const { sql } = compileCH(
			cloudflareZoneBreakdownTimeseriesSQL("path", {}, ["/a'b"]),
			timeseriesParams,
		)
		expect(sql).toContain("'/a\\'b'")
	})

	it("leaves the grouping alone when no topKeys are given", () => {
		const { sql } = compileCH(cloudflareZoneBreakdownTimeseriesSQL("statusClass"), timeseriesParams)
		expect(sql).not.toContain("if(")
		expect(sql).not.toContain(`'${CLOUDFLARE_BREAKDOWN_OTHER_KEY}'`)
	})
})

describe("cloudflareZoneBreakdownCoverageSQL", () => {
	it("reports when collection started, ignoring the caller's dimension filters", () => {
		const { sql } = compileCH(cloudflareZoneBreakdownCoverageSQL("path"), zoneParams)
		expect(sql).toContain("min(TimeUnix)")
		expect(sql).toContain("MetricName = 'cloudflare.http.requests.by_path'")
		// Coverage is a property of what the poller collected, not of the current selection.
		expect(sql).not.toContain("IN (")
	})
})

describe("cloudflareZoneFacetsQuery", () => {
	it("unions one branch per facet, each tagged with its type", () => {
		const { sql } = compileUnion(cloudflareZoneFacetsQuery(), zoneParams)
		expect(sql.match(/UNION ALL/g)?.length).toBe(7)
		for (const facetType of [
			"host",
			"cacheStatus",
			"statusClass",
			"path",
			"country",
			"method",
			"protocol",
			"deviceType",
		]) {
			expect(sql).toContain(`'${facetType}' AS facetType`)
		}
		// Weight, not entity count — the list is ranked by traffic.
		expect(sql).toContain("sum(Value) AS count")
	})

	it("self-excludes each facet so a selection does not hide its siblings", () => {
		const { sql } = compileUnion(cloudflareZoneFacetsQuery({ paths: ["/api"], hosts: ["a.example"] }), zoneParams)
		const branches = sql.split("UNION ALL")
		const pathBranch = branches.find((b) => b.includes("'path' AS facetType"))!
		const countryBranch = branches.find((b) => b.includes("'country' AS facetType"))!
		const hostBranch = branches.find((b) => b.includes("'host' AS facetType"))!

		// The path facet still lists every path…
		expect(pathBranch).not.toContain("url.path'] IN")
		// …and the host facet still lists every host…
		expect(hostBranch).not.toContain("IN ('a.example')")
		// …while the host filter narrows the other main-cube facets.
		const cacheBranch = branches.find((b) => b.includes("'cacheStatus' AS facetType"))!
		expect(cacheBranch).toContain("IN ('a.example')")
		// The country facet reads a family carrying neither key, so neither filter applies.
		expect(countryBranch).not.toContain("url.path'] IN")
		expect(countryBranch).not.toContain("IN ('a.example')")
	})
})

describe("row schemas coerce ClickHouse string-encoded aggregates", () => {
	const decode = <T>(compiled: CompiledQuery<T>, rows: ReadonlyArray<Record<string, unknown>>) =>
		Effect.runSync(compiled.decodeRows(rows))

	it("totals", () => {
		const compiled = compileCH(cloudflareZoneBreakdownTotalsSQL("path"), zoneParams, {
			rowSchema: cloudflareZoneBreakdownTotalsRowSchema,
		})
		const [row] = decode(compiled, [
			{ key: "/api", requests: "1200", errors5xx: "3", bytes: "999999999999" },
		])
		expect(row).toEqual({ key: "/api", requests: 1200, errors5xx: 3, bytes: 999999999999 })
	})

	it("timeseries", () => {
		const compiled = compileCH(cloudflareZoneBreakdownTimeseriesSQL("path"), timeseriesParams, {
			rowSchema: cloudflareZoneBreakdownTimeseriesRowSchema,
		})
		const [row] = decode(compiled, [
			{ bucket: "2026-07-02T00:00:00.000Z", key: "/api", requests: "42" },
		])
		expect(row?.requests).toBe(42)
	})

	it("coverage", () => {
		const compiled = compileCH(cloudflareZoneBreakdownCoverageSQL("path"), zoneParams, {
			rowSchema: cloudflareZoneBreakdownCoverageRowSchema,
		})
		const [row] = decode(compiled, [
			{ coverageStart: "2026-07-02T06:00:00.000Z", attributedRequests: "7" },
		])
		expect(row).toEqual({ coverageStart: "2026-07-02T06:00:00.000Z", attributedRequests: 7 })
	})
})
