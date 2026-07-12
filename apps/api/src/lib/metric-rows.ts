/**
 * Wire shapes for the `metrics_gauge` / `metrics_sum` datasources in the
 * collector Tinybird exporter layout (see metricsGauge/metricsSum in
 * packages/domain/src/tinybird/datasources.ts). Shared by every producer that
 * writes metric rows directly (demo seeder, Cloudflare analytics poller) so
 * the row layout has one authority.
 */

export type MetricAttrs = Record<string, string>

/** One row in the `metrics_gauge` datasource. */
export interface MetricGaugeRow {
	timestamp: string
	start_timestamp: string
	metric_name: string
	metric_description: string
	metric_unit: string
	metric_attributes: MetricAttrs
	service_name: string
	resource_schema_url: string
	resource_attributes: MetricAttrs
	scope_schema_url: string
	scope_name: string
	scope_version: string
	scope_attributes: MetricAttrs
	value: number
	flags: number
	exemplars_trace_id: string[]
	exemplars_span_id: string[]
	exemplars_timestamp: string[]
	exemplars_value: number[]
	exemplars_filtered_attributes: MetricAttrs[]
}

/** One row in the `metrics_sum` datasource. */
export interface MetricSumRow extends MetricGaugeRow {
	aggregation_temporality: number
	is_monotonic: boolean
}

/** ClickHouse DateTime64 wire format: "YYYY-MM-DD HH:MM:SS.mmm" in UTC. */
export const fmtMetricTs = (epochMs: number) =>
	new Date(epochMs).toISOString().replace("T", " ").replace("Z", "")
