import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	cloudflareDurableObjectCountersSQL,
	cloudflareQueueGaugesSQL,
	cloudflareZoneDnsBreakdownSQL,
	cloudflareZoneDnsTimeseriesSQL,
	cloudflareZoneFirewallTimeseriesSQL,
	cloudflareZoneFirewallTopSQL,
	cloudflareZoneHostBreakdownSQL,
	cloudflareZoneHostTimeseriesSQL,
} from "./cloudflare-infra-extended"

const baseParams = {
	orgId: "org_1",
	startTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}

const zoneParams = { ...baseParams, serviceName: "cloudflare/example.com" }
const zoneTimeseriesParams = { ...zoneParams, bucketSeconds: 300 }

describe("cloudflareZoneHostBreakdownSQL", () => {
	it("groups zone HTTP counters by the http.host attribute", () => {
		const { sql } = compileCH(cloudflareZoneHostBreakdownSQL(), zoneParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("ServiceName = 'cloudflare/example.com'")
		expect(sql).toContain("http.host']")
		expect(sql).toContain("http.status_class'] = '5xx'")
		expect(sql).toContain("cache.status'] IN ('hit', 'stale', 'revalidated', 'updating')")
		expect(sql).toContain("GROUP BY host")
		expect(sql).toContain("FORMAT JSON")
	})
})

describe("cloudflareZoneHostTimeseriesSQL", () => {
	it("buckets requests per host", () => {
		const { sql } = compileCH(cloudflareZoneHostTimeseriesSQL(), zoneTimeseriesParams)
		expect(sql).toContain("toStartOfInterval")
		expect(sql).toContain("MetricName = 'cloudflare.http.requests'")
		expect(sql).toContain("GROUP BY bucket, host")
	})
})

describe("cloudflareZoneFirewallTimeseriesSQL", () => {
	it("buckets firewall events by action", () => {
		const { sql } = compileCH(cloudflareZoneFirewallTimeseriesSQL(), zoneTimeseriesParams)
		expect(sql).toContain("MetricName = 'cloudflare.firewall.events'")
		expect(sql).toContain("firewall.action']")
		expect(sql).toContain("GROUP BY bucket, action")
	})
})

describe("cloudflareZoneFirewallTopSQL", () => {
	it("ranks (source, action, rule, host) combinations by event count", () => {
		const { sql } = compileCH(cloudflareZoneFirewallTopSQL(), zoneParams)
		expect(sql).toContain("firewall.source']")
		expect(sql).toContain("firewall.rule_id']")
		expect(sql).toContain("http.host']")
		expect(sql).toContain("ORDER BY events DESC")
		expect(sql).toContain("LIMIT 25")
	})
})

describe("cloudflareZoneDnsTimeseriesSQL", () => {
	it("buckets DNS queries by response code", () => {
		const { sql } = compileCH(cloudflareZoneDnsTimeseriesSQL(), zoneTimeseriesParams)
		expect(sql).toContain("MetricName = 'cloudflare.dns.queries'")
		expect(sql).toContain("dns.response_code']")
		expect(sql).toContain("GROUP BY bucket, responseCode")
	})
})

describe("cloudflareZoneDnsBreakdownSQL", () => {
	it("ranks query names with an NXDOMAIN share", () => {
		const { sql } = compileCH(cloudflareZoneDnsBreakdownSQL(), zoneParams)
		expect(sql).toContain("dns.query_name']")
		expect(sql).toContain("dns.response_code'] = 'NXDOMAIN'")
		expect(sql).toContain("ORDER BY queries DESC")
		expect(sql).toContain("LIMIT 25")
	})
})

describe("cloudflareQueueGaugesSQL", () => {
	it("rolls up backlog/concurrency gauges per queue pseudo-service with NaN guards", () => {
		const { sql } = compileCH(cloudflareQueueGaugesSQL(), baseParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain(
			"MetricName IN ('cloudflare.queue.backlog.messages', 'cloudflare.queue.backlog.bytes', 'cloudflare.queue.consumer.concurrency')",
		)
		expect(sql).toContain("maxIf(Value, MetricName = 'cloudflare.queue.backlog.messages')")
		// avgIf over an empty set is NaN → must be guarded.
		expect(sql).toContain("if(countIf(")
		expect(sql).toContain("GROUP BY serviceName")
	})
})

describe("cloudflareDurableObjectCountersSQL", () => {
	it("rolls up DO counters per implementing Worker service", () => {
		const { sql } = compileCH(cloudflareDurableObjectCountersSQL(), baseParams)
		expect(sql).toContain(
			"MetricName IN ('cloudflare.durable_object.requests', 'cloudflare.durable_object.errors')",
		)
		expect(sql).toContain("sumIf(Value, MetricName = 'cloudflare.durable_object.requests')")
		expect(sql).toContain("GROUP BY serviceName")
	})
})
