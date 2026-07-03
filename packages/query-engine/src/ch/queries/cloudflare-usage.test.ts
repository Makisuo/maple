import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import { cloudflareUsageQuery } from "./cloudflare-usage"

const baseParams = {
	orgId: "org_1",
	bucketSeconds: 3600,
	startTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}

describe("cloudflareUsageQuery", () => {
	it("compiles the hourly usage aggregation over metrics_sum", () => {
		const { sql } = compileCH(cloudflareUsageQuery(), baseParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain(
			"MetricName IN ('cloudflare.http.requests', 'cloudflare.worker.requests')",
		)
		expect(sql).toContain("toStartOfInterval(TimeUnix, INTERVAL 3600 SECOND)")
		expect(sql).toContain("sum(Value) AS requests")
		expect(sql).toContain("count() AS datapoints")
		expect(sql).toContain("formatDateTime(max(TimeUnix), '%Y-%m-%dT%H:%i:%S.%fZ') AS lastTimeUnix")
		expect(sql).toContain("TimeUnix >= '2026-07-02 00:00:00.000'")
		expect(sql).toContain("TimeUnix <= '2026-07-03 00:00:00.000'")
		expect(sql).toContain("GROUP BY serviceName, bucket")
		expect(sql).toContain("ORDER BY serviceName ASC, bucket ASC")
		expect(sql).toContain("FORMAT JSON")
	})

	it("escapes single quotes in orgId", () => {
		const { sql } = compileCH(cloudflareUsageQuery(), { ...baseParams, orgId: "org'evil" })
		expect(sql).toContain("OrgId = 'org\\'evil'")
	})
})
