import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileUnsafe, type CompiledQuery } from "@maple-dev/clickhouse-builder"
import {
	cloudflareDurableObjectCountersSQL,
	cloudflareQueueGaugesSQL,
	cloudflareZoneDnsBreakdownSQL,
	cloudflareZoneDnsTimeseriesSQL,
	cloudflareZoneFirewallTimeseriesSQL,
	cloudflareZoneFirewallTopSQL,
} from "./cloudflare-infra-extended"

const baseParams = {
	orgId: "org_1",
	startTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}

const zoneParams = { ...baseParams, serviceName: "cloudflare/example.com" }
const zoneTimeseriesParams = { ...zoneParams, bucketSeconds: 300 }

describe("cloudflareZoneFirewallTimeseriesSQL", () => {
	it("buckets firewall events by action", () => {
		const { sql } = compileUnsafe(cloudflareZoneFirewallTimeseriesSQL(), zoneTimeseriesParams)
		expect(sql).toContain("MetricName = 'cloudflare.firewall.events'")
		expect(sql).toContain("firewall.action']")
		expect(sql).toContain("GROUP BY bucket, action")
	})
})

describe("cloudflareZoneFirewallTopSQL", () => {
	it("ranks (source, action, rule, host) combinations by event count", () => {
		const { sql } = compileUnsafe(cloudflareZoneFirewallTopSQL(), zoneParams)
		expect(sql).toContain("firewall.source']")
		expect(sql).toContain("firewall.rule_id']")
		// Firewall rows carry the same coalesced host attribute as the HTTP breakdowns.
		expect(sql).toContain("server.address']")
		expect(sql).toContain("http.host']")
		expect(sql).toContain("ORDER BY events DESC")
		expect(sql).toContain("LIMIT 25")
	})
})

describe("cloudflareZoneDnsTimeseriesSQL", () => {
	it("buckets DNS queries by response code", () => {
		const { sql } = compileUnsafe(cloudflareZoneDnsTimeseriesSQL(), zoneTimeseriesParams)
		expect(sql).toContain("MetricName = 'cloudflare.dns.queries'")
		expect(sql).toContain("dns.response_code']")
		expect(sql).toContain("GROUP BY bucket, responseCode")
	})
})

describe("cloudflareZoneDnsBreakdownSQL", () => {
	it("ranks query names with an NXDOMAIN share", () => {
		const { sql } = compileUnsafe(cloudflareZoneDnsBreakdownSQL(), zoneParams)
		expect(sql).toContain("dns.query_name']")
		expect(sql).toContain("dns.response_code'] = 'NXDOMAIN'")
		expect(sql).toContain("ORDER BY queries DESC")
		expect(sql).toContain("LIMIT 25")
	})
})

describe("cloudflareQueueGaugesSQL", () => {
	it("rolls up backlog/concurrency gauges per queue pseudo-service with NaN guards", () => {
		const { sql } = compileUnsafe(cloudflareQueueGaugesSQL(), baseParams)
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
		const { sql } = compileUnsafe(cloudflareDurableObjectCountersSQL(), baseParams)
		expect(sql).toContain(
			"MetricName IN ('cloudflare.durable_object.requests', 'cloudflare.durable_object.errors')",
		)
		expect(sql).toContain("sumIf(Value, MetricName = 'cloudflare.durable_object.requests')")
		expect(sql).toContain("GROUP BY serviceName")
	})
})

// CHNumber coercion — a BYO-ClickHouse org reads its OWN ClickHouse, whose
// `FORMAT JSON` serializes UInt64/Int64 aggregates (sum/count/max/…) as JSON
// STRINGS, while managed Tinybird returns them as numbers. Every numeric output
// column here is `CHNumber` (Finite | FiniteFromString), so `decodeRows` must
// coerce those strings back to numbers; without that coercion a BYO-CH org gets
// a bare 500. The row schema is derived from the SELECT's own column types, so
// these tests drive each query through the exact `compileUnsafe(...).decodeRows`
// path the query-engine handlers use, feeding string-encoded rows (the BYO-CH
// shape).
describe("CHNumber row-schema coercion (BYO-CH string-encoded aggregates)", () => {
	const decodeFirst = <O>(compiled: CompiledQuery<O>, row: Record<string, unknown>): O => {
		const [decoded] = Effect.runSync(compiled.decodeRows([row]))
		if (decoded === undefined) throw new Error("expected a decoded row")
		return decoded
	}

	it("cloudflareZoneFirewallTimeseriesSQL coerces string events", () => {
		const compiled = compileUnsafe(cloudflareZoneFirewallTimeseriesSQL(), zoneTimeseriesParams)
		expect(
			decodeFirst(compiled, {
				bucket: "2026-07-02T00:00:00.000Z",
				action: "block",
				events: "1234",
			}),
		).toEqual({ bucket: "2026-07-02T00:00:00.000Z", action: "block", events: 1234 })
	})

	it("cloudflareZoneFirewallTopSQL coerces string events", () => {
		const compiled = compileUnsafe(cloudflareZoneFirewallTopSQL(), zoneParams)
		expect(
			decodeFirst(compiled, {
				source: "waf",
				action: "managed_challenge",
				ruleId: "rule-1",
				host: "app.example.com",
				events: "777",
			}),
		).toEqual({
			source: "waf",
			action: "managed_challenge",
			ruleId: "rule-1",
			host: "app.example.com",
			events: 777,
		})
	})

	it("cloudflareZoneDnsTimeseriesSQL coerces string queries", () => {
		const compiled = compileUnsafe(cloudflareZoneDnsTimeseriesSQL(), zoneTimeseriesParams)
		expect(
			decodeFirst(compiled, {
				bucket: "2026-07-02T00:00:00.000Z",
				responseCode: "NOERROR",
				queries: "654321",
			}),
		).toEqual({ bucket: "2026-07-02T00:00:00.000Z", responseCode: "NOERROR", queries: 654321 })
	})

	it("cloudflareZoneDnsBreakdownSQL coerces string queries and nxdomain", () => {
		const compiled = compileUnsafe(cloudflareZoneDnsBreakdownSQL(), zoneParams)
		expect(
			decodeFirst(compiled, {
				queryName: "example.com",
				queries: "1000",
				nxdomain: "3",
			}),
		).toEqual({ queryName: "example.com", queries: 1000, nxdomain: 3 })
	})

	it("cloudflareQueueGaugesSQL coerces string gauges", () => {
		const compiled = compileUnsafe(cloudflareQueueGaugesSQL(), baseParams)
		expect(
			decodeFirst(compiled, {
				serviceName: "cloudflare-queue/q-1",
				backlogMessages: "12.5",
				backlogMessagesMax: "40",
				backlogBytes: "2048",
				consumerConcurrency: "3",
			}),
		).toEqual({
			serviceName: "cloudflare-queue/q-1",
			backlogMessages: 12.5,
			backlogMessagesMax: 40,
			backlogBytes: 2048,
			consumerConcurrency: 3,
		})
	})

	it("cloudflareDurableObjectCountersSQL coerces string counters", () => {
		const compiled = compileUnsafe(cloudflareDurableObjectCountersSQL(), baseParams)
		expect(
			decodeFirst(compiled, {
				serviceName: "cloudflare-worker/do-worker",
				requests: "50000",
				errors: "12",
			}),
		).toEqual({ serviceName: "cloudflare-worker/do-worker", requests: 50000, errors: 12 })
	})

	it("still accepts managed-Tinybird numeric aggregates (the union's other branch)", () => {
		const compiled = compileUnsafe(cloudflareDurableObjectCountersSQL(), baseParams)
		expect(
			decodeFirst(compiled, {
				serviceName: "cloudflare-worker/do-worker",
				requests: 50000,
				errors: 12,
			}),
		).toEqual({ serviceName: "cloudflare-worker/do-worker", requests: 50000, errors: 12 })
	})
})
