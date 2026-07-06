import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	cloudflareWorkerCountersSQL,
	cloudflareWorkerLatencySQL,
	cloudflareWorkerTimeseriesSQL,
	cloudflareZoneCacheTimeseriesSQL,
	cloudflareZoneCountersSQL,
	cloudflareZoneLatencySQL,
	cloudflareZoneLatencyTimeseriesSQL,
	cloudflareZoneStatusTimeseriesSQL,
	cloudflareZoneTimeseriesSQL,
} from "./cloudflare-infra"

const baseParams = {
	orgId: "org_1",
	startTime: "2026-07-02 00:00:00.000",
	endTime: "2026-07-03 00:00:00.000",
}

const timeseriesParams = { ...baseParams, bucketSeconds: 300 }

describe("cloudflareZoneCountersSQL", () => {
	it("rolls up HTTP counters per zone with 5xx and served-by-cache breakdowns", () => {
		const { sql } = compileCH(cloudflareZoneCountersSQL(), baseParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain(
			"MetricName IN ('cloudflare.http.requests', 'cloudflare.http.bytes', 'cloudflare.http.visits')",
		)
		expect(sql).toContain("http.status_class'] = '5xx'")
		expect(sql).toContain("cache.status'] IN ('hit', 'stale', 'revalidated', 'updating')")
		expect(sql).toContain("sumIf(Value, MetricName = 'cloudflare.http.bytes')")
		expect(sql).toContain("sumIf(Value, MetricName = 'cloudflare.http.visits')")
		// Worker analytics live in their own queries.
		expect(sql).not.toContain("cloudflare.worker")
		expect(sql).toContain("GROUP BY serviceName")
		expect(sql).toContain("FORMAT JSON")
	})

	it("escapes single quotes in orgId", () => {
		const { sql } = compileCH(cloudflareZoneCountersSQL(), { ...baseParams, orgId: "org'evil" })
		expect(sql).toContain("OrgId = 'org\\'evil'")
	})
})

describe("cloudflareZoneLatencySQL", () => {
	it("guards each percentile against empty-set NaN and reads all three quantiles", () => {
		const { sql } = compileCH(cloudflareZoneLatencySQL(), baseParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain(
			"MetricName IN ('cloudflare.http.edge.ttfb', 'cloudflare.http.origin.duration')",
		)
		expect(sql).toContain("quantile'] = '0.5'")
		expect(sql).toContain("quantile'] = '0.95'")
		expect(sql).toContain("quantile'] = '0.99'")
		expect(sql).toContain("if(countIf(")
		expect(sql).not.toContain("cloudflare.worker")
		expect(sql).toContain("GROUP BY serviceName")
		expect(sql).toContain("FORMAT JSON")
	})
})

describe("cloudflareZoneTimeseriesSQL", () => {
	it("buckets zone counters by interval and orders for chart consumption", () => {
		const { sql } = compileCH(cloudflareZoneTimeseriesSQL(), timeseriesParams)
		expect(sql).toContain("toStartOfInterval(TimeUnix, INTERVAL 300 SECOND)")
		expect(sql).toContain("http.status_class'] = '5xx'")
		expect(sql).toContain("GROUP BY serviceName, bucket")
		expect(sql).toContain("ORDER BY serviceName ASC, bucket ASC")
		expect(sql).toContain("FORMAT JSON")
	})
})

const detailParams = { ...timeseriesParams, serviceName: "cloudflare/example.com" }

describe("cloudflareZoneStatusTimeseriesSQL", () => {
	it("groups one zone's requests by bucket and status class", () => {
		const { sql } = compileCH(cloudflareZoneStatusTimeseriesSQL(), detailParams)
		expect(sql).toContain("ServiceName = 'cloudflare/example.com'")
		expect(sql).toContain("MetricName = 'cloudflare.http.requests'")
		expect(sql).toContain("http.status_class'] AS statusClass")
		expect(sql).toContain("GROUP BY bucket, statusClass")
		expect(sql).toContain("FORMAT JSON")
	})
})

describe("cloudflareZoneCacheTimeseriesSQL", () => {
	it("groups one zone's requests by bucket and raw cache status", () => {
		const { sql } = compileCH(cloudflareZoneCacheTimeseriesSQL(), detailParams)
		expect(sql).toContain("ServiceName = 'cloudflare/example.com'")
		expect(sql).toContain("cache.status'] AS cacheStatus")
		expect(sql).toContain("GROUP BY bucket, cacheStatus")
		expect(sql).toContain("FORMAT JSON")
	})
})

describe("cloudflareZoneLatencyTimeseriesSQL", () => {
	it("buckets NaN-guarded percentiles for one zone", () => {
		const { sql } = compileCH(cloudflareZoneLatencyTimeseriesSQL(), detailParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain("ServiceName = 'cloudflare/example.com'")
		expect(sql).toContain("quantile'] = '0.95'")
		expect(sql).toContain("if(countIf(")
		expect(sql).toContain("GROUP BY bucket")
		expect(sql).toContain("FORMAT JSON")
	})
})

describe("cloudflareWorkerCountersSQL", () => {
	it("rolls up Worker invocations / errors / subrequests per script", () => {
		const { sql } = compileCH(cloudflareWorkerCountersSQL(), baseParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain(
			"MetricName IN ('cloudflare.worker.requests', 'cloudflare.worker.errors', 'cloudflare.worker.subrequests')",
		)
		expect(sql).toContain("sumIf(Value, MetricName = 'cloudflare.worker.subrequests')")
		expect(sql).not.toContain("cloudflare.http")
		expect(sql).toContain("GROUP BY serviceName")
		expect(sql).toContain("FORMAT JSON")
	})
})

describe("cloudflareWorkerLatencySQL", () => {
	it("reads only the quantiles the poller emits for Workers (0.5 / 0.99)", () => {
		const { sql } = compileCH(cloudflareWorkerLatencySQL(), baseParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain(
			"MetricName IN ('cloudflare.worker.duration', 'cloudflare.worker.cpu_time')",
		)
		expect(sql).toContain("quantile'] = '0.5'")
		expect(sql).toContain("quantile'] = '0.99'")
		expect(sql).not.toContain("'0.95'")
		expect(sql).toContain("if(countIf(")
		expect(sql).toContain("FORMAT JSON")
	})
})

describe("cloudflareWorkerTimeseriesSQL", () => {
	it("buckets Worker counters by interval", () => {
		const { sql } = compileCH(cloudflareWorkerTimeseriesSQL(), timeseriesParams)
		expect(sql).toContain("toStartOfInterval(TimeUnix, INTERVAL 300 SECOND)")
		expect(sql).toContain("sumIf(Value, MetricName = 'cloudflare.worker.errors')")
		expect(sql).toContain("GROUP BY serviceName, bucket")
		expect(sql).toContain("FORMAT JSON")
	})
})
