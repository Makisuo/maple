/**
 * Encode collector-shaped metric rows (`MetricSumRow` / `MetricGaugeRow`) into an OTLP/HTTP JSON
 * `ExportMetricsServiceRequest`, so the Cloudflare poller can ship its synthetic edge metrics
 * through the ingest gateway (`POST /v1/metrics`) exactly like every other telemetry source —
 * which is what gives per-org routing (managed Tinybird vs BYO ClickHouse), schema-version gating,
 * WAL durability, and Autumn metering for free. The rows are already OTel-metric-shaped, so this is
 * a mechanical re-expression: no query paths change (the downstream collector still lands them in
 * `metrics_sum` / `metrics_gauge`).
 *
 * Rows are grouped resource → scope → metric to match the OTLP envelope: sum rows become `sum`
 * metrics (carrying the row's `aggregation_temporality` — 1 = DELTA — and `is_monotonic`), gauge
 * rows become bare `gauge` metrics. Timestamps are the row's ClickHouse DateTime64 literal
 * ("YYYY-MM-DD HH:MM:SS.mmm", UTC) converted to unix-nanosecond strings.
 *
 * Note: the gateway strips any client-supplied `org_id` / `maple_org_id` and re-sets it from the
 * resolved ingest key, so leaving `maple_org_id` in `resource_attributes` is harmless.
 */
import type { MetricAttrs, MetricGaugeRow, MetricSumRow } from "@/lib/metric-rows"

interface OtlpKeyValue {
	readonly key: string
	readonly value: { readonly stringValue: string }
}

interface OtlpNumberDataPoint {
	readonly startTimeUnixNano: string
	readonly timeUnixNano: string
	readonly asDouble: number
	readonly attributes: ReadonlyArray<OtlpKeyValue>
}

interface OtlpMetric {
	readonly name: string
	readonly description: string
	readonly unit: string
	readonly sum?: {
		readonly aggregationTemporality: number
		readonly isMonotonic: boolean
		readonly dataPoints: OtlpNumberDataPoint[]
	}
	readonly gauge?: {
		readonly dataPoints: OtlpNumberDataPoint[]
	}
}

interface OtlpScopeMetrics {
	readonly scope: {
		readonly name: string
		readonly version: string
		readonly attributes: ReadonlyArray<OtlpKeyValue>
	}
	readonly schemaUrl: string
	readonly metrics: OtlpMetric[]
}

interface OtlpResourceMetrics {
	readonly resource: { readonly attributes: ReadonlyArray<OtlpKeyValue> }
	readonly schemaUrl: string
	readonly scopeMetrics: OtlpScopeMetrics[]
}

export interface OtlpMetricsPayload {
	readonly resourceMetrics: OtlpResourceMetrics[]
}

const toKeyValues = (attrs: MetricAttrs): OtlpKeyValue[] =>
	Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } }))

/** ClickHouse DateTime64 literal ("YYYY-MM-DD HH:MM:SS.mmm", UTC) → unix-nanosecond string. */
const tsToUnixNano = (ts: string): string => {
	const ms = Date.parse(`${ts.replace(" ", "T")}Z`)
	// ns = ms × 1e6; append six zeros so the value stays exact past 2^53.
	return `${ms}000000`
}

const dataPoint = (row: MetricGaugeRow): OtlpNumberDataPoint => ({
	startTimeUnixNano: tsToUnixNano(row.start_timestamp),
	timeUnixNano: tsToUnixNano(row.timestamp),
	asDouble: row.value,
	attributes: toKeyValues(row.metric_attributes),
})

/**
 * Stable identity keys for grouping. Resource/scope attribute maps are produced by the same
 * builders per (service, dataset), so JSON of the sorted entries is a sound grouping key.
 */
const stableJson = (attrs: MetricAttrs): string =>
	JSON.stringify(Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))

interface ScopeAcc {
	readonly scope: OtlpScopeMetrics["scope"]
	readonly schemaUrl: string
	readonly metrics: Map<string, OtlpMetric>
}

interface ResourceAcc {
	readonly resource: OtlpResourceMetrics["resource"]
	readonly schemaUrl: string
	readonly scopes: Map<string, ScopeAcc>
}

const resourceKey = (row: MetricGaugeRow): string =>
	`${row.resource_schema_url}\x00${stableJson(row.resource_attributes)}`

const scopeKey = (row: MetricGaugeRow): string =>
	`${row.scope_schema_url}\x00${row.scope_name}\x00${row.scope_version}\x00${stableJson(row.scope_attributes)}`

/**
 * Convert Cloudflare metric rows into a single OTLP/JSON metrics request. Sum and gauge metrics
 * coexist in the same envelope; the downstream collector fans them back out to
 * `metrics_sum` / `metrics_gauge`.
 */
export const metricRowsToOtlp = (
	sumRows: ReadonlyArray<MetricSumRow>,
	gaugeRows: ReadonlyArray<MetricGaugeRow>,
): OtlpMetricsPayload => {
	const resources = new Map<string, ResourceAcc>()

	const scopeFor = (row: MetricGaugeRow): ScopeAcc => {
		const rKey = resourceKey(row)
		let resource = resources.get(rKey)
		if (!resource) {
			resource = {
				resource: { attributes: toKeyValues(row.resource_attributes) },
				schemaUrl: row.resource_schema_url,
				scopes: new Map(),
			}
			resources.set(rKey, resource)
		}
		const sKey = scopeKey(row)
		let scope = resource.scopes.get(sKey)
		if (!scope) {
			scope = {
				scope: {
					name: row.scope_name,
					version: row.scope_version,
					attributes: toKeyValues(row.scope_attributes),
				},
				schemaUrl: row.scope_schema_url,
				metrics: new Map(),
			}
			resource.scopes.set(sKey, scope)
		}
		return scope
	}

	for (const row of sumRows) {
		const scope = scopeFor(row)
		const existing = scope.metrics.get(row.metric_name)
		if (existing?.sum) {
			existing.sum.dataPoints.push(dataPoint(row))
		} else {
			scope.metrics.set(row.metric_name, {
				name: row.metric_name,
				description: row.metric_description,
				unit: row.metric_unit,
				sum: {
					aggregationTemporality: row.aggregation_temporality,
					isMonotonic: row.is_monotonic,
					dataPoints: [dataPoint(row)],
				},
			})
		}
	}

	for (const row of gaugeRows) {
		const scope = scopeFor(row)
		const existing = scope.metrics.get(row.metric_name)
		if (existing?.gauge) {
			existing.gauge.dataPoints.push(dataPoint(row))
		} else {
			scope.metrics.set(row.metric_name, {
				name: row.metric_name,
				description: row.metric_description,
				unit: row.metric_unit,
				gauge: { dataPoints: [dataPoint(row)] },
			})
		}
	}

	return {
		resourceMetrics: [...resources.values()].map((resource) => ({
			resource: resource.resource,
			schemaUrl: resource.schemaUrl,
			scopeMetrics: [...resource.scopes.values()].map((scope) => ({
				scope: scope.scope,
				schemaUrl: scope.schemaUrl,
				metrics: [...scope.metrics.values()],
			})),
		})),
	}
}
