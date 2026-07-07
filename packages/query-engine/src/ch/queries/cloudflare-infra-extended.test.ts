import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compileCH, type CompiledQuery } from "@maple-dev/clickhouse-builder"
import {
	cloudflareDurableObjectCountersRowSchema,
	cloudflareDurableObjectCountersSQL,
	cloudflareQueueGaugesRowSchema,
	cloudflareQueueGaugesSQL,
	cloudflareZoneDnsBreakdownRowSchema,
	cloudflareZoneDnsBreakdownSQL,
	cloudflareZoneDnsTimeseriesRowSchema,
	cloudflareZoneDnsTimeseriesSQL,
	cloudflareZoneFirewallTimeseriesRowSchema,
	cloudflareZoneFirewallTimeseriesSQL,
	cloudflareZoneFirewallTopRowSchema,
	cloudflareZoneFirewallTopSQL,
	cloudflareZoneHostBreakdownRowSchema,
	cloudflareZoneHostBreakdownSQL,
	cloudflareZoneHostTimeseriesRowSchema,
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

// ---------------------------------------------------------------------------
// CHNumber coercion — a BYO-ClickHouse org reads its OWN ClickHouse, whose
// `FORMAT JSON` serializes UInt64/Int64 aggregates (sum/count/max/…) as JSON
// STRINGS, while managed Tinybird returns them as numbers. Every numeric output
// column here is `CHNumber` (Finite | FiniteFromString), so `decodeRows` must
// coerce those strings back to numbers; without the row-schema a BYO-CH org gets
// a bare 500. These tests drive each (SQL, rowSchema) pair through the exact
// `compileCH(...).decodeRows` path the query-engine handlers use, feeding
// string-encoded rows (the BYO-CH shape).
// ---------------------------------------------------------------------------
describe("CHNumber row-schema coercion (BYO-CH string-encoded aggregates)", () => {
	const decodeFirst = <O>(compiled: CompiledQuery<O>, row: Record<string, unknown>): O => {
		const [decoded] = Effect.runSync(compiled.decodeRows([row]))
		if (decoded === undefined) throw new Error("expected a decoded row")
		return decoded
	}

	it("cloudflareZoneHostBreakdownRowSchema coerces string counters", () => {
		const compiled = compileCH(cloudflareZoneHostBreakdownSQL(), zoneParams, {
			rowSchema: cloudflareZoneHostBreakdownRowSchema,
		})
		expect(
			decodeFirst(compiled, {
				host: "app.example.com",
				requests: "12345678901",
				errors5xx: "42",
				cacheHits: "9999",
				bytes: "88888888888",
			}),
		).toEqual({
			host: "app.example.com",
			requests: 12345678901,
			errors5xx: 42,
			cacheHits: 9999,
			bytes: 88888888888,
		})
	})

	it("cloudflareZoneHostTimeseriesRowSchema coerces string requests", () => {
		const compiled = compileCH(cloudflareZoneHostTimeseriesSQL(), zoneTimeseriesParams, {
			rowSchema: cloudflareZoneHostTimeseriesRowSchema,
		})
		expect(
			decodeFirst(compiled, {
				bucket: "2026-07-02T00:00:00.000Z",
				host: "app.example.com",
				requests: "500",
			}),
		).toEqual({ bucket: "2026-07-02T00:00:00.000Z", host: "app.example.com", requests: 500 })
	})

	it("cloudflareZoneFirewallTimeseriesRowSchema coerces string events", () => {
		const compiled = compileCH(cloudflareZoneFirewallTimeseriesSQL(), zoneTimeseriesParams, {
			rowSchema: cloudflareZoneFirewallTimeseriesRowSchema,
		})
		expect(
			decodeFirst(compiled, {
				bucket: "2026-07-02T00:00:00.000Z",
				action: "block",
				events: "1234",
			}),
		).toEqual({ bucket: "2026-07-02T00:00:00.000Z", action: "block", events: 1234 })
	})

	it("cloudflareZoneFirewallTopRowSchema coerces string events", () => {
		const compiled = compileCH(cloudflareZoneFirewallTopSQL(), zoneParams, {
			rowSchema: cloudflareZoneFirewallTopRowSchema,
		})
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

	it("cloudflareZoneDnsTimeseriesRowSchema coerces string queries", () => {
		const compiled = compileCH(cloudflareZoneDnsTimeseriesSQL(), zoneTimeseriesParams, {
			rowSchema: cloudflareZoneDnsTimeseriesRowSchema,
		})
		expect(
			decodeFirst(compiled, {
				bucket: "2026-07-02T00:00:00.000Z",
				responseCode: "NOERROR",
				queries: "654321",
			}),
		).toEqual({ bucket: "2026-07-02T00:00:00.000Z", responseCode: "NOERROR", queries: 654321 })
	})

	it("cloudflareZoneDnsBreakdownRowSchema coerces string queries and nxdomain", () => {
		const compiled = compileCH(cloudflareZoneDnsBreakdownSQL(), zoneParams, {
			rowSchema: cloudflareZoneDnsBreakdownRowSchema,
		})
		expect(
			decodeFirst(compiled, {
				queryName: "example.com",
				queries: "1000",
				nxdomain: "3",
			}),
		).toEqual({ queryName: "example.com", queries: 1000, nxdomain: 3 })
	})

	it("cloudflareQueueGaugesRowSchema coerces string gauges", () => {
		const compiled = compileCH(cloudflareQueueGaugesSQL(), baseParams, {
			rowSchema: cloudflareQueueGaugesRowSchema,
		})
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

	it("cloudflareDurableObjectCountersRowSchema coerces string counters", () => {
		const compiled = compileCH(cloudflareDurableObjectCountersSQL(), baseParams, {
			rowSchema: cloudflareDurableObjectCountersRowSchema,
		})
		expect(
			decodeFirst(compiled, {
				serviceName: "cloudflare-worker/do-worker",
				requests: "50000",
				errors: "12",
			}),
		).toEqual({ serviceName: "cloudflare-worker/do-worker", requests: 50000, errors: 12 })
	})

	it("still accepts managed-Tinybird numeric aggregates (the union's other branch)", () => {
		const compiled = compileCH(cloudflareDurableObjectCountersSQL(), baseParams, {
			rowSchema: cloudflareDurableObjectCountersRowSchema,
		})
		expect(
			decodeFirst(compiled, {
				serviceName: "cloudflare-worker/do-worker",
				requests: 50000,
				errors: 12,
			}),
		).toEqual({ serviceName: "cloudflare-worker/do-worker", requests: 50000, errors: 12 })
	})
})
