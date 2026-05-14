import {
	getColumnJsonPath,
	getColumnType,
	getTinybirdType,
	isDatasourceDefinition,
} from "@tinybirdco/sdk"
import * as Datasources from "@maple/domain/tinybird"

// ---------------------------------------------------------------------------
// Live introspection of the `defineDatasource` exports in
// packages/domain/src/tinybird/datasources.ts. Used by the MCP
// `describe_warehouse_tables` tool so agents discover real tables/columns at
// call time rather than relying on a hand-maintained list inside the tool
// description.
//
// Type strings (`String`, `DateTime64(9)`, `LowCardinality(String)`,
// `Map(LowCardinality(String), String)`) come straight from the SDK's
// `getTinybirdType()`. Curated notes — enum casing, unit warnings, sort-key
// hints — live in the TABLE_NOTES record below; the type system can't infer
// them but they cause the most expensive agent mistakes.
// ---------------------------------------------------------------------------

const TABLE_NOTES: Record<string, ReadonlyArray<string>> = {
	logs: [
		"`SeverityText` values are Title Case: 'Trace', 'Debug', 'Info', 'Warn', 'Error', 'Fatal'. Filter with `SeverityText = 'Error'` (NOT `'ERROR'`).",
		"`SeverityNumber` follows OTel: 1-4 Trace, 5-8 Debug, 9-12 Info, 13-16 Warn, 17-20 Error, 21-24 Fatal.",
		"`ResourceAttributes` and `LogAttributes` are `Map(LowCardinality(String), String)` — access with `LogAttributes['key']`; missing keys return '' (empty string), not NULL.",
		"Use `TimestampTime` (DateTime) for `$__timeFilter(TimestampTime)` if you want sort-key-prefix-friendly filtering; `Timestamp` is DateTime64 (nanosecond precision).",
		"Sorting key: `(OrgId, ServiceName, TimestampTime, Timestamp)` — adding `ServiceName = '…'` to the WHERE clause speeds queries dramatically.",
	],
	traces: [
		"`StatusCode` values are Title Case: 'Ok', 'Error', 'Unset'. Filter with `StatusCode = 'Error'` (NOT `'ERROR'`).",
		"`SpanKind` values are Title Case: 'Internal', 'Server', 'Client', 'Producer', 'Consumer'.",
		"`Duration` is in NANOSECONDS (UInt64). Divide by 1e6 for milliseconds, 1e9 for seconds.",
		"`SpanAttributes` and `ResourceAttributes` are `Map(LowCardinality(String), String)` — access with `SpanAttributes['http.route']`; missing keys return '' not NULL.",
		"`SampleRate` defaults to 1.0; multiply counts by `SampleRate` for unbiased throughput estimates.",
		"Sorting key starts with `(OrgId, ServiceName, Timestamp)` — filter on these first.",
		"For service-level metrics (per-service throughput, latency), prefer `service_overview_spans` — it's pre-filtered to entry-point spans and ~10× smaller.",
	],
	service_overview_spans: [
		"Pre-materialized projection of entry-point spans only (Server/Consumer kinds + root spans). Use for per-service request count, error rate, p50/p95/p99 latency.",
		"`Duration` is NANOSECONDS — divide by 1e6 for ms.",
		"`StatusCode` is Title Case: 'Ok', 'Error', 'Unset'.",
		"Does NOT include `SpanAttributes`/`ResourceAttributes` — query `traces` if you need attribute access.",
	],
	error_spans: [
		"Pre-filtered to `StatusCode = 'Error'`. Use this instead of `traces WHERE StatusCode = 'Error'`.",
		"`Duration` is NANOSECONDS.",
		"`DeploymentEnv` is pre-extracted from ResourceAttributes['deployment.environment'].",
	],
	error_events: [
		"Per-error-occurrence rows with the OTel `exception` event unwrapped — surfaces `ExceptionType`, `ExceptionMessage`, `Stacktrace`, and a stable `FingerprintHash` for grouping.",
		"Use `FingerprintHash` to group occurrences into issues; `(OrgId, FingerprintHash, Timestamp)` is the sort key.",
	],
	metrics_sum: [
		"Cumulative or delta counter metrics. Use `rate(Value) OVER (PARTITION BY MetricName ORDER BY TimeUnix)` for rate-of-change when `IsMonotonic=1`.",
		"`Attributes` is a Map — filter with `Attributes['service.name']`.",
	],
	metrics_gauge: [
		"Point-in-time numeric values. Aggregate with avg/min/max/last over time buckets.",
	],
	metrics_histogram: [
		"Pre-aggregated histograms (bucket counts + sum + count). Reconstruct percentiles with `quantilesExact`/`quantileBFloat16` if needed.",
	],
}

export interface ColumnInfo {
	readonly name: string
	readonly type: string
	readonly jsonPath?: string
}

export interface TableSummary {
	readonly name: string
	readonly description?: string
	readonly columnCount: number
}

export interface TableInfo extends TableSummary {
	readonly columns: ReadonlyArray<ColumnInfo>
	readonly notes?: ReadonlyArray<string>
	readonly sortingKey?: ReadonlyArray<string> | string
	readonly partitionKey?: string
}

function collectDatasources() {
	// `Datasources` exports a mix of datasource definitions, type aliases, helper
	// functions, and constant lookup tables. `isDatasourceDefinition` is the
	// runtime filter; we cast to `unknown` first because the static union of all
	// exports is too wide for TS to narrow with the predicate.
	return (Object.values(Datasources) as ReadonlyArray<unknown>).filter(
		isDatasourceDefinition,
	)
}

export function listWarehouseTables(): ReadonlyArray<TableSummary> {
	return collectDatasources()
		.map((ds) => ({
			name: ds._name,
			description: ds.options.description,
			columnCount: Object.keys(ds._schema).length,
		}))
		.sort((a, b) => a.name.localeCompare(b.name))
}

export function describeWarehouseTable(name: string): TableInfo | null {
	const ds = collectDatasources().find((d) => d._name === name)
	if (!ds) return null

	const columns: ColumnInfo[] = Object.entries(ds._schema).map(([colName, colDef]) => {
		const validator = getColumnType(colDef)
		const type = getTinybirdType(validator)
		const jsonPath = getColumnJsonPath(colDef)
		return jsonPath ? { name: colName, type, jsonPath } : { name: colName, type }
	})

	const engine = ds.options.engine as
		| { sortingKey?: ReadonlyArray<string> | string; partitionKey?: string }
		| undefined

	return {
		name: ds._name,
		description: ds.options.description,
		columnCount: columns.length,
		columns,
		notes: TABLE_NOTES[ds._name],
		sortingKey: engine?.sortingKey,
		partitionKey: engine?.partitionKey,
	}
}
