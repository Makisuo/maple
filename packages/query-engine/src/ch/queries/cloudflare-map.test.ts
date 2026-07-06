import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import { cloudflareServiceCountersSQL, cloudflareServiceLatencySQL } from "./cloudflare-map"

const baseParams = {
	orgId: "org_1",
	startTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}

describe("cloudflareServiceCountersSQL", () => {
	it("aggregates Worker requests / errors per script over metrics_sum", () => {
		const { sql } = compileCH(cloudflareServiceCountersSQL(), baseParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("MetricName IN ('cloudflare.worker.requests', 'cloudflare.worker.errors')")
		expect(sql).toContain("sumIf(Value, MetricName = 'cloudflare.worker.requests')")
		expect(sql).toContain("sumIf(Value, MetricName = 'cloudflare.worker.errors')")
		// Zone analytics are intentionally excluded — CF data only overlays onto
		// instrumented services, and zones never match one.
		expect(sql).not.toContain("cloudflare.http.requests")
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
		expect(sql).toContain("MetricName IN ('cloudflare.worker.duration', 'cloudflare.worker.cpu_time')")
		expect(sql).toContain("quantile'] = '0.99'")
		expect(sql).toContain("if(countIf(")
		expect(sql).not.toContain("cloudflare.http.edge.ttfb")
		expect(sql).toContain("GROUP BY serviceName")
		expect(sql).toContain("FORMAT JSON")
	})
})
