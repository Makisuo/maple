import { describe, expect, it } from "vitest"
import { compileUnsafe } from "@maple-dev/clickhouse-builder"
import { cloudflareZoneCacheTimeseriesSQL } from "./cloudflare-infra"
import { cloudflareZoneBreakdownTotalsSQL } from "./cloudflare-infra-breakdowns"
import { cloudflareZoneFirewallTopSQL } from "./cloudflare-infra-extended"
import { CF_METRIC, cloudflareIgnoredFilters, cloudflareIgnoredFiltersFor } from "./cloudflare-infra-filters"

const zoneParams = {
	orgId: "org_1",
	serviceName: "cloudflare/example.com",
	startTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}

describe("cloudflareFilterConditions", () => {
	it("emits an IN predicate for a key the metric family carries", () => {
		const { sql } = compileUnsafe(
			cloudflareZoneBreakdownTotalsSQL("path", { paths: ["/api/users", "/health"] }),
			zoneParams,
		)
		expect(sql).toContain("url.path'] IN ('/api/users', '/health')")
	})

	it("emits NOTHING for a key the metric family does not carry", () => {
		// The safety property: `cloudflare.http.requests` rows have no url.path, so a path filter
		// must be dropped rather than compiled into a predicate that matches zero rows and silently
		// blanks the cache chart.
		const { sql } = compileUnsafe(
			cloudflareZoneCacheTimeseriesSQL({ paths: ["/api/users"], cacheStatuses: ["miss"] }),
			{ ...zoneParams, bucketSeconds: 300 },
		)
		expect(sql).not.toContain("url.path")
		expect(sql).toContain("cache.status'] IN ('miss')")
	})

	it("routes the host filter through the same transitional coalesce as the grouping key", () => {
		// A host read off a chart built on pre-rename rows must still filter to those rows.
		const { sql } = compileUnsafe(cloudflareZoneFirewallTopSQL({ hosts: ["a.example.com"] }), zoneParams)
		expect(sql).toContain("server.address']")
		expect(sql).toContain("http.host']")
		expect(sql).toContain("IN ('a.example.com')")
	})

	it("compiles pathContains to a case-insensitive substring match", () => {
		const { sql } = compileUnsafe(
			cloudflareZoneBreakdownTotalsSQL("path", { pathContains: "/api" }),
			zoneParams,
		)
		expect(sql).toContain("positionCaseInsensitive(")
		expect(sql).toContain("'/api'")
	})

	it("escapes quotes in filter values so a value cannot terminate its literal", () => {
		const { sql } = compileUnsafe(
			cloudflareZoneBreakdownTotalsSQL("path", { paths: ["/a'; DROP TABLE metrics_sum; --"] }),
			zoneParams,
		)
		expect(sql).toContain("IN ('/a\\'\\x3B DROP TABLE metrics_sum\\x3B --')")
		// The raw (unescaped) quote never reaches the SQL.
		expect(sql).not.toContain("('/a';")
	})

	it("produces no condition for empty or absent values", () => {
		const bare = compileUnsafe(cloudflareZoneBreakdownTotalsSQL("path"), zoneParams).sql
		const empty = compileUnsafe(
			cloudflareZoneBreakdownTotalsSQL("path", { paths: [], pathContains: "" }),
			zoneParams,
		).sql
		expect(empty).toBe(bare)
		expect(bare).not.toContain("AND  ")
	})
})

describe("cloudflareIgnoredFilters", () => {
	it("reports keys the caller asked for that this family cannot honor", () => {
		expect(cloudflareIgnoredFilters({ paths: ["/a"], hosts: ["h"] }, ["host", "cacheStatus"])).toEqual([
			"path",
		])
	})

	it("counts a bare pathContains as a requested path filter", () => {
		expect(cloudflareIgnoredFilters({ pathContains: "/api" }, [])).toEqual(["path"])
	})

	it("ignores nothing when every requested key is applicable", () => {
		expect(cloudflareIgnoredFilters({ hosts: ["h"] }, ["host"])).toEqual([])
	})

	it("unions applicability across every family a panel reads", () => {
		// The latency panel reads only quantile gauges, so every dimension filter is inapplicable.
		expect(
			cloudflareIgnoredFiltersFor({ hosts: ["h"], countries: ["DE"] }, [
				CF_METRIC.edgeTtfb,
				CF_METRIC.originDuration,
			]),
		).toEqual(["host", "country"])
		// The status chart reads the main cube, which does carry hosts.
		expect(
			cloudflareIgnoredFiltersFor({ hosts: ["h"], countries: ["DE"] }, [CF_METRIC.requests]),
		).toEqual(["country"])
	})
})
