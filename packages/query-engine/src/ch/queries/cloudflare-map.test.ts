import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import { cloudflareServiceCountersSQL, cloudflareServiceLatencySQL } from "./cloudflare-map"

const baseParams = {
	orgId: "org_1",
	startTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}

describe("cloudflareServiceCountersSQL", () => {
	it("aggregates requests / errors / cache hits per CF service over metrics_sum", () => {
		const { sql } = compileCH(cloudflareServiceCountersSQL(), baseParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain(
			"MetricName IN ('cloudflare.http.requests', 'cloudflare.worker.requests', 'cloudflare.worker.errors')",
		)
		// requests = http.requests OR worker.requests
		expect(sql).toContain(
			"sumIf(Value, (MetricName = 'cloudflare.http.requests' OR MetricName = 'cloudflare.worker.requests'))",
		)
		// errors = (http.requests AND 5xx) OR worker.errors
		expect(sql).toContain("http.status_class'] = '5xx'")
		expect(sql).toContain("MetricName = 'cloudflare.worker.errors'")
		// cache hits
		expect(sql).toContain("cache.status'] = 'hit'")
		expect(sql).toContain("TimeUnix >= '2026-07-02 00:00:00.000'")
		expect(sql).toContain("TimeUnix <= '2026-07-03 00:00:00.000'")
		expect(sql).toContain("GROUP BY serviceName")
		expect(sql).toContain("FORMAT JSON")
	})

	it("escapes single quotes in orgId", () => {
		const { sql } = compileCH(cloudflareServiceCountersSQL(), { ...baseParams, orgId: "org'evil" })
		expect(sql).toContain("OrgId = 'org\\'evil'")
	})
})

describe("cloudflareServiceLatencySQL", () => {
	it("guards each percentile against empty-set NaN and reads metrics_gauge quantiles", () => {
		const { sql } = compileCH(cloudflareServiceLatencySQL(), baseParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain(
			"MetricName IN ('cloudflare.http.edge.ttfb', 'cloudflare.http.origin.duration', 'cloudflare.worker.duration', 'cloudflare.worker.cpu_time')",
		)
		// zone TTFB p95 OR worker duration p99, guarded by countIf > 0
		expect(sql).toContain("cloudflare.http.edge.ttfb")
		expect(sql).toContain("quantile'] = '0.95'")
		expect(sql).toContain("quantile'] = '0.99'")
		expect(sql).toContain("if(countIf(")
		expect(sql).toContain("GROUP BY serviceName")
		expect(sql).toContain("FORMAT JSON")
	})
})
