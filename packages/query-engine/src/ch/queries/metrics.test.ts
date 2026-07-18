import { describe, expect, it } from "vitest"
import { compileCH } from "@maple-dev/clickhouse-builder"
import {
	metricsTimeseriesQuery,
	metricsTimeseriesRateQuery,
	metricsBreakdownQuery,
	metricsSparklinesQuery,
	listMetricsQuery,
	metricsSummaryQuery,
} from "./metrics"

const baseParams = {
	orgId: "org_1",
	startTime: "2024-01-01 00:00:00",
	endTime: "2024-01-02 00:00:00",
	bucketSeconds: 3600,
	metricName: "cpu.utilization",
}

// ---------------------------------------------------------------------------
// metricsTimeseriesQuery
// ---------------------------------------------------------------------------

describe("metricsTimeseriesQuery", () => {
	it("compiles value timeseries (sum)", () => {
		const q = metricsTimeseriesQuery({ metricType: "sum" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("avg(Value) AS avgValue")
		expect(sql).toContain("min(Value) AS minValue")
		expect(sql).toContain("max(Value) AS maxValue")
		expect(sql).toContain("sum(Value) AS sumValue")
		expect(sql).toContain("count() AS dataPointCount")
		expect(sql).toContain("INTERVAL 3600 SECOND")
		expect(sql).toContain("GROUP BY bucket, serviceName")
		expect(sql).toContain("ORDER BY bucket ASC")
		expect(sql).toContain("FORMAT JSON")
	})

	it("compiles value timeseries (gauge)", () => {
		const q = metricsTimeseriesQuery({ metricType: "gauge" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM metrics_gauge")
	})

	it("compiles histogram timeseries", () => {
		const q = metricsTimeseriesQuery({ metricType: "histogram" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM metrics_histogram")
		expect(sql).toContain("sum(Sum) / sum(Count)")
		expect(sql).toContain("min(Min) AS minValue")
		expect(sql).toContain("max(Max) AS maxValue")
		expect(sql).toContain("sum(Sum) AS sumValue")
		expect(sql).toContain("sum(Count) AS dataPointCount")
	})

	it("compiles exponential_histogram timeseries", () => {
		const q = metricsTimeseriesQuery({ metricType: "exponential_histogram" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM metrics_exponential_histogram")
	})

	it("applies groupByAttributeKey", () => {
		const q = metricsTimeseriesQuery({ metricType: "sum", groupByAttributeKey: "region" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("Attributes['region']")
		expect(sql).toContain("GROUP BY bucket, serviceName, attributeValue")
	})

	it("caps grouped value timeseries before returning the long tail", () => {
		const q = metricsTimeseriesQuery({
			metricType: "sum",
			groupBy: ["service"],
			seriesLimit: 7,
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("WITH __series_base AS")
		expect(sql).toContain("LIMIT 7")
	})

	it("applies serviceName filter", () => {
		const q = metricsTimeseriesQuery({ metricType: "sum", serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})

	it("applies attribute key/value filter", () => {
		const q = metricsTimeseriesQuery({
			metricType: "sum",
			attributeKey: "region",
			attributeValue: "us-east-1",
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("Attributes['region'] = 'us-east-1'")
	})

	it("shows empty string as attributeValue when no groupByAttributeKey", () => {
		const q = metricsTimeseriesQuery({ metricType: "sum" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("'' AS attributeValue")
	})

	it("applies groupByResourceAttributeKey against ResourceAttributes", () => {
		const q = metricsTimeseriesQuery({ metricType: "gauge", groupByResourceAttributeKey: "host.name" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['host.name'] AS attributeValue")
		expect(sql).toContain("GROUP BY bucket, serviceName, attributeValue")
	})

	it("applies resourceAttributeFilters", () => {
		const q = metricsTimeseriesQuery({
			metricType: "gauge",
			resourceAttributeFilters: [{ key: "k8s.cluster.name", mode: "equals", value: "prod-us-east" }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['k8s.cluster.name'] = 'prod-us-east'")
	})
})

// ---------------------------------------------------------------------------
// metricsTimeseriesRateQuery
// ---------------------------------------------------------------------------

describe("metricsTimeseriesRateQuery", () => {
	it("caps grouped rate timeseries before returning the long tail", () => {
		const q = metricsTimeseriesRateQuery({ groupBy: ["service"], seriesLimit: 7 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("WITH __series_base AS")
		expect(sql).toContain("LIMIT 7")
	})

	it("compiles CTE-based rate query", () => {
		const q = metricsTimeseriesRateQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("WITH with_deltas AS")
		expect(sql).toContain("lagInFrame")
		// Partition must isolate each pod/series (ResourceAttributes) and
		// accumulation epoch (StartTimeUnix) — otherwise cumulative deltas are
		// computed across interleaved replicas and inflate by orders of magnitude.
		// The attribute Maps are folded into cityHash64 series fingerprints so the
		// window sort key is fixed-width instead of a serialized Map per row.
		expect(sql).toContain(
			"PARTITION BY ServiceName, MetricName, " +
				"cityHash64(mapKeys(Attributes), mapValues(Attributes)), " +
				"cityHash64(mapKeys(ResourceAttributes), mapValues(ResourceAttributes)), " +
				"StartTimeUnix",
		)
		expect(sql).toContain("ROWS BETWEEN 1 PRECEDING AND CURRENT ROW")
		expect(sql).toContain("rateValue")
		expect(sql).toContain("increaseValue")
		expect(sql).toContain("sumIf(")
		expect(sql).toContain("FROM with_deltas")
		expect(sql).toContain("FORMAT JSON")
	})

	it("applies serviceName filter in CTE", () => {
		const q = metricsTimeseriesRateQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})

	it("applies attributeKey filter", () => {
		const q = metricsTimeseriesRateQuery({
			attributeKey: "region",
			attributeValue: "us-east-1",
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("Attributes['region'] = 'us-east-1'")
	})

	it("applies groupByAttributeKey", () => {
		const q = metricsTimeseriesRateQuery({ groupByAttributeKey: "host" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("Attributes['host']")
		expect(sql).toContain("GROUP BY bucket, serviceName, attributeValue")
	})

	it("applies groupByResourceAttributeKey through the deltas CTE", () => {
		const q = metricsTimeseriesRateQuery({ groupByResourceAttributeKey: "k8s.pod.name" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['k8s.pod.name'] AS resourceAttributeValue")
		expect(sql).toContain("resourceAttributeValue AS attributeValue")
		expect(sql).toContain("GROUP BY bucket, serviceName, attributeValue")
	})

	it("applies resourceAttributeFilters in the CTE", () => {
		const q = metricsTimeseriesRateQuery({
			resourceAttributeFilters: [{ key: "host.name", mode: "equals", value: "web-01" }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['host.name'] = 'web-01'")
	})

	it("falls back to raw metrics_sum when resource opts are present (hourly rollup lacks the map)", () => {
		const withGroup = metricsTimeseriesRateQuery({
			metricName: "span.metrics.calls",
			bucketSeconds: 3600,
			groupByResourceAttributeKey: "host.name",
		})
		expect(compileCH(withGroup, { ...baseParams, metricName: "span.metrics.calls" }).sql).toContain(
			"FROM metrics_sum",
		)

		const withFilter = metricsTimeseriesRateQuery({
			metricName: "span.metrics.calls",
			bucketSeconds: 3600,
			resourceAttributeFilters: [{ key: "host.name", mode: "equals", value: "web-01" }],
		})
		expect(compileCH(withFilter, { ...baseParams, metricName: "span.metrics.calls" }).sql).toContain(
			"FROM metrics_sum",
		)
	})

	it("uses the hourly SpanMetrics calls rollup for hourly calls increases", () => {
		const q = metricsTimeseriesRateQuery({
			metricName: "span.metrics.calls",
			bucketSeconds: 3600,
		})
		const { sql } = compileCH(q, { ...baseParams, metricName: "span.metrics.calls" })
		expect(sql).toContain("FROM span_metrics_calls_hourly")
		expect(sql).toContain("argMaxMerge(LastValue) AS Value")
		expect(sql).toContain("WITH hourly_values AS")
		expect(sql).toContain("WITH")
		expect(sql).toContain("FROM with_deltas")
		expect(sql).toContain("sumIf(delta, delta >= 0) AS increaseValue")
		expect(sql).not.toContain("FROM metrics_sum")
	})

	it("applies span.kind filters on the hourly SpanMetrics calls rollup", () => {
		const q = metricsTimeseriesRateQuery({
			metricName: "span.metrics.calls",
			bucketSeconds: 3600,
			attributeKey: "span.kind",
			attributeValue: "SPAN_KIND_SERVER",
			groupByAttributeKey: "span.kind",
		})
		const { sql } = compileCH(q, { ...baseParams, metricName: "span.metrics.calls" })
		expect(sql).toContain("SpanKind = 'SPAN_KIND_SERVER'")
		expect(sql).toContain("SpanKind AS attributeValue")
		expect(sql).toContain("GROUP BY bucket, serviceName, attributeValue")
	})

	it("falls back to raw metrics_sum when attributeValue has no attributeKey", () => {
		const q = metricsTimeseriesRateQuery({
			metricName: "span.metrics.calls",
			bucketSeconds: 3600,
			attributeValue: "SPAN_KIND_SERVER",
		})
		const { sql } = compileCH(q, { ...baseParams, metricName: "span.metrics.calls" })
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).not.toContain("span_metrics_calls_hourly")
	})

	it("falls back to raw metrics_sum for non-hourly SpanMetrics calls buckets", () => {
		const q = metricsTimeseriesRateQuery({
			metricName: "span.metrics.calls",
			bucketSeconds: 60,
		})
		const { sql } = compileCH(q, {
			...baseParams,
			metricName: "span.metrics.calls",
			bucketSeconds: 60,
		})
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).not.toContain("span_metrics_calls_hourly")
	})

	it("matches a candidate metricNames set with MetricName IN (...)", () => {
		const q = metricsTimeseriesRateQuery({
			metricName: "span.metrics.calls",
			metricNames: ["span.metrics.calls", "calls"],
			bucketSeconds: 3600,
		})
		const { sql } = compileCH(q, { ...baseParams, metricName: "span.metrics.calls" })
		// A multi-name IN(...) can't be served from the single-name hourly rollup,
		// so it stays on the raw path with an IN filter (no scalar equality).
		expect(sql).toContain("MetricName IN ('span.metrics.calls', 'calls')")
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).not.toContain("span_metrics_calls_hourly")
		expect(sql).not.toContain("MetricName = {metricName")
	})
})

// ---------------------------------------------------------------------------
// metricsBreakdownQuery
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// metricsSparklinesQuery
// ---------------------------------------------------------------------------

describe("metricsSparklinesQuery", () => {
	it("compiles a batched IN query grouped per metric and bucket", () => {
		const q = metricsSparklinesQuery({
			metricType: "gauge",
			metricNames: ["cpu.utilization", "memory.usage"],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM metrics_gauge")
		expect(sql).toContain("MetricName IN ('cpu.utilization', 'memory.usage')")
		expect(sql).toContain("MetricName AS metricName")
		expect(sql).toContain("avg(Value) AS avgValue")
		expect(sql).toContain("sum(Value) AS sumValue")
		expect(sql).toContain("count() AS dataPointCount")
		expect(sql).toContain("GROUP BY bucket, metricName")
		expect(sql).toContain("ORDER BY bucket ASC")
		expect(sql).toContain("FORMAT JSON")
	})

	it("uses histogram aggregate expressions for histogram tables", () => {
		const q = metricsSparklinesQuery({
			metricType: "histogram",
			metricNames: ["http.server.duration"],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM metrics_histogram")
		expect(sql).toContain("sum(Sum) / sum(Count)")
		expect(sql).toContain("sum(Count) AS dataPointCount")
	})

	it("scopes to org and time range", () => {
		const q = metricsSparklinesQuery({ metricType: "sum", metricNames: ["calls"] })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("OrgId = 'org_1'")
		expect(sql).toContain("TimeUnix >=")
		expect(sql).toContain("TimeUnix <=")
	})
})

describe("metricsBreakdownQuery", () => {
	it("compiles value breakdown", () => {
		const q = metricsBreakdownQuery({ metricType: "sum" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM metrics_sum")
		expect(sql).toContain("ServiceName AS name")
		expect(sql).toContain("avg(Value) AS avgValue")
		expect(sql).toContain("GROUP BY name")
		expect(sql).toContain("ORDER BY count DESC")
		expect(sql).toContain("LIMIT 10")
		expect(sql).toContain("FORMAT JSON")
	})

	it("compiles histogram breakdown", () => {
		const q = metricsBreakdownQuery({ metricType: "histogram" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("FROM metrics_histogram")
		expect(sql).toContain("sum(Sum)")
		expect(sql).toContain("sum(Count)")
	})

	it("applies custom limit", () => {
		const q = metricsBreakdownQuery({ metricType: "sum", limit: 25 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 25")
	})

	it("breaks down by resource attribute when groupByResourceAttributeKey is set", () => {
		const q = metricsBreakdownQuery({ metricType: "sum", groupByResourceAttributeKey: "host.name" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['host.name'] AS name")
		// Drops datapoints missing the resource label.
		expect(sql).toContain("ResourceAttributes['host.name'] != ''")
	})

	it("applies resourceAttributeFilters", () => {
		const q = metricsBreakdownQuery({
			metricType: "sum",
			resourceAttributeFilters: [{ key: "k8s.namespace.name", mode: "equals", value: "default" }],
		})
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ResourceAttributes['k8s.namespace.name'] = 'default'")
	})

	it("breaks down by attribute label instead of service when groupByAttributeKey is set", () => {
		const q = metricsBreakdownQuery({ metricType: "sum", groupByAttributeKey: "region" })
		const { sql } = compileCH(q, baseParams)
		// Groups by the label value, not ServiceName...
		expect(sql).toContain("Attributes['region'] AS name")
		expect(sql).not.toContain("ServiceName AS name")
		// ...and drops datapoints missing the label so an empty bucket can't dominate.
		expect(sql).toContain("Attributes['region'] != ''")
		expect(sql).toContain("GROUP BY name")
	})
})

// ---------------------------------------------------------------------------
// listMetricsQuery
// ---------------------------------------------------------------------------

describe("listMetricsQuery", () => {
	it("reads the metric_catalog rollup", () => {
		const q = listMetricsQuery({})
		const { sql } = compileCH(q, baseParams)
		expect(sql).not.toContain("UNION ALL")
		expect(sql).toContain("FROM metric_catalog")
		expect(sql).toContain("GROUP BY metricName, metricType, serviceName")
		expect(sql).toContain("ORDER BY lastSeen DESC, metricName ASC, metricType ASC, serviceName ASC")
		expect(sql).toContain("LIMIT 100")
		// start bound floored to the hour
		expect(sql).toContain("toStartOfInterval")
	})

	it("filters by metricType", () => {
		const q = listMetricsQuery({ metricType: "sum" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("MetricType = 'sum'")
	})

	it("applies search filter", () => {
		const q = listMetricsQuery({ search: "http" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ILIKE '%http%'")
	})

	it("applies serviceName filter", () => {
		const q = listMetricsQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})

	it("applies custom limit and offset", () => {
		const q = listMetricsQuery({ limit: 50, offset: 10 })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("LIMIT 50")
		expect(sql).toContain("OFFSET 10")
	})
})

// ---------------------------------------------------------------------------
// metricsSummaryQuery
// ---------------------------------------------------------------------------

describe("metricsSummaryQuery", () => {
	it("aggregates the metric_catalog rollup by metric type", () => {
		const q = metricsSummaryQuery()
		const { sql } = compileCH(q, baseParams)
		expect(sql).not.toContain("UNION ALL")
		expect(sql).toContain("FROM metric_catalog")
		expect(sql).toContain("GROUP BY metricType")
		expect(sql).toContain("uniq(MetricName)")
		expect(sql).toContain("sum(DataPointCount)")
	})

	it("applies serviceName filter", () => {
		const q = metricsSummaryQuery({ serviceName: "api" })
		const { sql } = compileCH(q, baseParams)
		expect(sql).toContain("ServiceName = 'api'")
	})
})
