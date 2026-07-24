import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	cloudflareUsageQuery,
	cloudflareUsageStatsQuery,
	cloudflareUsageStatsRowSchema,
} from "./cloudflare-usage"

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

const statsParams = {
	orgId: "org_1",
	prevStartTime: "2026-07-01 00:00:00.000",
	currentStartTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}

describe("cloudflareUsageStatsQuery", () => {
	it("compiles the single-row previous-window + firewall aggregate", () => {
		const { sql } = compileCH(cloudflareUsageStatsQuery(), statsParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("OrgId = 'org_1'")
		// Outer scan covers both windows and every metric either sumIf needs.
		expect(sql).toContain(
			"MetricName IN ('cloudflare.http.requests', 'cloudflare.worker.requests', 'cloudflare.firewall.events')",
		)
		expect(sql).toContain("TimeUnix >= '2026-07-01 00:00:00.000'")
		expect(sql).toContain("TimeUnix <= '2026-07-03 00:00:00.000'")
		// Previous window: usage metrics strictly before the current window start.
		expect(sql).toContain(
			"sumIf(Value, (MetricName IN ('cloudflare.http.requests', 'cloudflare.worker.requests') AND TimeUnix < '2026-07-02 00:00:00.000')) AS previousRequests",
		)
		// Current window: mitigating firewall actions only (no skip/log).
		expect(sql).toContain("MetricName = 'cloudflare.firewall.events'")
		expect(sql).toContain(
			"Attributes['firewall.action'] IN ('block', 'challenge', 'jschallenge', 'managed_challenge')",
		)
		expect(sql).toContain("TimeUnix >= '2026-07-02 00:00:00.000')) AS firewallBlockedEvents")
		expect(sql).not.toContain("GROUP BY")
		expect(sql).toContain("FORMAT JSON")
	})

	it("escapes single quotes in orgId", () => {
		const { sql } = compileCH(cloudflareUsageStatsQuery(), { ...statsParams, orgId: "org'evil" })
		expect(sql).toContain("OrgId = 'org\\'evil'")
	})

	it("row schema coerces BYO-CH string-encoded aggregates", () => {
		const compiled = compileCH(cloudflareUsageStatsQuery(), statsParams, {
			rowSchema: cloudflareUsageStatsRowSchema,
		})
		const decoded = Effect.runSync(
			compiled.decodeRows([{ previousRequests: "12345", firewallBlockedEvents: "678" }]),
		)
		expect(decoded).toEqual([{ previousRequests: 12345, firewallBlockedEvents: 678 }])
	})
})
