import { CHART_DISPLAY_AREA, buildPortableDashboard, metricsTimeseries, templateId } from "../helpers"
import type { TemplateDefinition, WidgetDef } from "../types"

// ---------------------------------------------------------------------------
// Maple-internal: cross-org ingest volume.
//
// Reads `maple_ingest_org_bytes_total` / `maple_ingest_org_items_total`, the
// delta counters the Rust gateway emits from its billing call site (see
// `apps/ingest/src/usage_metrics.rs`). They are written under Maple's OWN org
// with the tenant org carried as the `org_id` datapoint attribute — which is
// what lets this dashboard read cross-org volume through the ordinary
// org-scoped query path, with no privileged endpoint and no new security
// surface. It is the product's normal dashboard machinery, pointed at Maple.
//
// Two things to know before editing:
//
//  - **Aggregation is `sum`, never `rate`/`increase`.** These are delta
//    counters: each exported point already is its interval's increment, so
//    summing per bucket is exact. `rate`/`increase` lower to a `lagInFrame`
//    reconstruction meant for cumulative counters and would double-difference
//    the data.
//  - **Bytes are real.** `unit: "bytes"` formats decimally (1000-based), the
//    same basis Autumn bills GB on, so these readouts are directly comparable
//    to an invoice. This is deliberately NOT `service_usage`, whose *SizeBytes
//    columns are storage heuristics that cannot reconcile with billing.
//
// A series labelled with an empty `org_id` means the SDK hit its per-interval
// cardinality limit and folded the excess into an `otel.metric.overflow`
// bucket: real bytes, unattributed. Treat it as a signal to raise
// `USAGE_CARDINALITY_LIMIT`, not as noise.
// ---------------------------------------------------------------------------

const BYTES_METRIC = "maple_ingest_org_bytes_total"
const ITEMS_METRIC = "maple_ingest_org_items_total"

/** Bytes ingested across every org, for the dashboard's time range. */
function totalBytesSql(signal?: string): string {
	const signalFilter = signal ? `\n  AND Attributes['signal'] = '${signal}'` : ""
	return `SELECT sum(Value) AS value
FROM metrics_sum
WHERE $__orgFilter
  AND MetricName = '${BYTES_METRIC}'
  AND $__timeFilter(TimeUnix)${signalFilter}`
}

/**
 * Top orgs by ingested bytes, pivoted per signal. Raw SQL rather than
 * `custom_query_builder_breakdown` because that lowering hardcodes
 * `ORDER BY count DESC` — it cannot rank by a summed value, which is the whole
 * question here.
 */
const TOP_ORGS_SQL = `SELECT Attributes['org_id'] AS org_id,
       sum(Value) AS total_bytes,
       sumIf(Value, Attributes['signal'] = 'logs') AS logs_bytes,
       sumIf(Value, Attributes['signal'] = 'traces') AS traces_bytes,
       sumIf(Value, Attributes['signal'] = 'metrics') AS metrics_bytes
FROM metrics_sum
WHERE $__orgFilter
  AND MetricName = '${BYTES_METRIC}'
  AND $__timeFilter(TimeUnix)
GROUP BY org_id
ORDER BY total_bytes DESC
LIMIT 100`

function statWidget(opts: { id: string; title: string; signal?: string; x: number }): WidgetDef {
	return {
		id: opts.id,
		visualization: "stat",
		dataSource: {
			endpoint: "raw_sql_chart",
			params: { sql: totalBytesSql(opts.signal), displayType: "stat" },
			transform: { reduceToValue: { field: "value", aggregate: "first" } },
		},
		display: { title: opts.title, unit: "bytes" },
		layout: { x: opts.x, y: 0, w: 3, h: 2 },
	}
}

/** Stacked-area byte volume, grouped by one attribute dimension. */
function bytesChart(opts: {
	id: string
	title: string
	groupBy: string
	signal?: string
	layout: WidgetDef["layout"]
}): WidgetDef {
	return {
		id: opts.id,
		visualization: "chart",
		dataSource: metricsTimeseries({
			id: opts.id,
			name: opts.title,
			metricName: BYTES_METRIC,
			metricType: "sum",
			aggregation: "sum",
			isMonotonic: true,
			whereClause: opts.signal ? `attr.signal = "${opts.signal}"` : "",
			groupBy: [opts.groupBy],
		}),
		display: { title: opts.title, ...CHART_DISPLAY_AREA, unit: "bytes" },
		layout: opts.layout,
	}
}

function widgets(): WidgetDef[] {
	return [
		statWidget({ id: "total-bytes", title: "Total Ingested", x: 0 }),
		statWidget({ id: "logs-bytes", title: "Logs", signal: "logs", x: 3 }),
		statWidget({ id: "traces-bytes", title: "Traces", signal: "traces", x: 6 }),
		statWidget({ id: "metrics-bytes", title: "Metrics", signal: "metrics", x: 9 }),
		bytesChart({
			id: "bytes-by-org",
			title: "Ingested Bytes by Org",
			groupBy: "attr.org_id",
			layout: { x: 0, y: 2, w: 6, h: 6 },
		}),
		bytesChart({
			id: "bytes-by-signal",
			title: "Ingested Bytes by Signal",
			groupBy: "attr.signal",
			layout: { x: 6, y: 2, w: 6, h: 6 },
		}),
		// The per-signal-by-org split that a single widget cannot express: metrics
		// queries carry one attribute group column, so the signal becomes a filter
		// and each signal gets its own chart.
		bytesChart({
			id: "log-bytes-by-org",
			title: "Log Bytes by Org",
			groupBy: "attr.org_id",
			signal: "logs",
			layout: { x: 0, y: 8, w: 4, h: 6 },
		}),
		bytesChart({
			id: "trace-bytes-by-org",
			title: "Trace Bytes by Org",
			groupBy: "attr.org_id",
			signal: "traces",
			layout: { x: 4, y: 8, w: 4, h: 6 },
		}),
		bytesChart({
			id: "metric-bytes-by-org",
			title: "Metric Bytes by Org",
			groupBy: "attr.org_id",
			signal: "metrics",
			layout: { x: 8, y: 8, w: 4, h: 6 },
		}),
		{
			id: "items-by-signal",
			visualization: "chart",
			dataSource: metricsTimeseries({
				id: "items-by-signal",
				name: "Items by Signal",
				metricName: ITEMS_METRIC,
				metricType: "sum",
				aggregation: "sum",
				isMonotonic: true,
				groupBy: ["attr.signal"],
			}),
			display: { title: "Items Ingested by Signal", ...CHART_DISPLAY_AREA, unit: "number" },
			layout: { x: 0, y: 14, w: 6, h: 6 },
		},
		{
			id: "top-orgs",
			visualization: "table",
			dataSource: {
				endpoint: "raw_sql_chart",
				params: { sql: TOP_ORGS_SQL, displayType: "table" },
			},
			display: {
				title: "Top Orgs by Ingested Bytes",
				columns: [
					{ field: "org_id", header: "Org" },
					{ field: "total_bytes", header: "Total", unit: "bytes", align: "right" },
					{ field: "logs_bytes", header: "Logs", unit: "bytes", align: "right" },
					{ field: "traces_bytes", header: "Traces", unit: "bytes", align: "right" },
					{ field: "metrics_bytes", header: "Metrics", unit: "bytes", align: "right" },
				],
			},
			layout: { x: 6, y: 14, w: 6, h: 6 },
		},
	]
}

export const mapleIngestVolumeTemplate: TemplateDefinition = {
	id: templateId("maple-ingest-volume"),
	name: "Maple Internal — Ingest Volume",
	description:
		"Cross-org ingested bytes and item counts by org and signal, measured at the billing call site.",
	category: "application",
	tags: ["internal", "ingest", "usage"],
	requirements: ["Maple internal org", "Ingest gateway usage metrics"],
	requiredMetricPrefixes: ["maple_ingest_org_"],
	internal: true,
	parameters: [],
	build: () =>
		buildPortableDashboard({
			name: "Maple Internal — Ingest Volume",
			description:
				"Cross-org ingest volume from the gateway's own delta counters. Bytes are the real decoded payload size metered to billing — comparable to Autumn invoices, unlike service_usage's storage estimates.",
			tags: ["internal", "ingest-volume"],
			timeRange: "24h",
			widgets: widgets(),
		}),
}
