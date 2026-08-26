// SQL Catalog
//
// Every SQL string the product can emit, enumerated from the real dispatch and
// lowering code paths rather than hand-written.
//
// This exists because query-engine's tests assert on SQL *text*. Text is not a
// contract ClickHouse honours: `if(sum(Float64Col) > 0, …, sum(UInt64Col))`
// compiles to exactly the expected string and is then rejected by the analyzer
// with `NO_COMMON_TYPE`. That shipped, took every main chart to a 502, and CI
// stayed green because the assertion pinned the broken text verbatim.
//
// The catalog feeds a sweep that runs each SQL through `DESCRIBE (SELECT …)` on
// a real ClickHouse. `DESCRIBE` runs the full analyzer without reading a row and
// returns each output column's resolved type, which catches two classes at once:
//
//   1. SQL the analyzer rejects (the bug above).
//   2. 64-bit integer columns that a query's `rowSchema` decodes with a bare
//      `Schema.Number`. ClickHouse's `FORMAT JSON` emits UInt64/Int64 as JSON
//      *strings*, so those are a plain 500 for BYO-ClickHouse orgs. See
//      `CHNumber` in `ch/schema.ts`.
//
// Fixtures are a route matrix, not a happy path. A query function that picks
// between materialized views and raw scans is several unrelated SQL shapes
// wearing one name, and only the shape the fixture happens to select is ever
// executed. `assertRouteCoverage` below fails when a route is never exercised.

import { Effect } from "effect"
import type { CompiledQuery } from "@maple-dev/clickhouse-builder"
import {
	DeploymentEnvironment,
	MetricName,
	OrgId,
	QueryEngineExecuteRequest,
	ServiceName,
	warehouseQueries,
	type QuerySpec,
	type WarehouseQueryName,
} from "@maple/domain"
import { baselineWarehouseCapabilities, type WarehouseCapabilities } from "./capabilities"
import * as CH from "./ch"
import { builderFixtures } from "./ch/builder-fixtures"
import { compilePipeQuery } from "./ch/pipe-dispatch"
import { compiledQueryOf } from "./execution/compiled-input"
import { fingerprintSql } from "./execution/fingerprint"
import { makeQueryEngineExecute, type QueryEngineWarehouse, type QueryTenant } from "./runtime"

// Fixture inputs

const ORG_ID = "org_sql_catalog"
/** A window that spans whole hours plus partial edges on both sides, so the
 *  edge-hour + rollup-interior union shapes both produce non-degenerate SQL. */
const START_TIME = "2026-01-01 10:30:00"
const END_TIME = "2026-01-03 14:15:00"
/** Narrow window for fine-grained buckets — the lowering rejects a timeseries
 *  whose bucket count is unreasonable, so a 60s fixture needs hours, not days. */
const SHORT_START_TIME = "2026-01-03 10:30:00"
const SHORT_END_TIME = "2026-01-03 14:15:00"

/**
 * Capability sets that change generated SQL. `attributeIndexMode` and
 * `logBodySearchMode` fan out into different WHERE shapes (`hasToken`, bloom
 * lookups, plain scans), so a fixture run under one set says nothing about the
 * others.
 */
export const capabilityVariants: ReadonlyArray<{
	readonly label: string
	readonly capabilities: WarehouseCapabilities
}> = [
	{ label: "baseline", capabilities: baselineWarehouseCapabilities() },
	{
		label: "bloom",
		capabilities: {
			...baselineWarehouseCapabilities(),
			metadataAvailable: true,
			features: new Set(["logs.attributes.bloom", "traces.attributes.bloom", "logs.body.tokenbf"]),
		},
	},
	{
		label: "text",
		capabilities: {
			...baselineWarehouseCapabilities(),
			metadataAvailable: true,
			fullTextSearchSetting: "enabled",
			features: new Set(["logs.attributes.text", "traces.attributes.text", "logs.body.text"]),
		},
	},
]

export interface PipeFixture {
	readonly pipe: WarehouseQueryName
	/** Distinguishes fixtures for the same pipe; appears in failure output. */
	readonly label: string
	/** The routing decision this fixture exists to pin, if any. */
	readonly route?: string
	readonly params: Record<string, unknown>
	/** Run under every capability variant, not just the baseline. */
	readonly allCapabilities?: boolean
}

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const FINGERPRINT = "11640393269246331608"

/**
 * At least one fixture per name in `warehouseQueries` — enforced by
 * `assertPipeCoverage`, so adding a pipe without a fixture breaks the build.
 */
export const pipeFixtures: ReadonlyArray<PipeFixture> = [
	{ pipe: "list_traces", label: "default", params: {}, allCapabilities: true },
	{
		pipe: "list_traces",
		label: "filtered",
		params: {
			service: "api",
			span_name: "GET /v1/x",
			has_error: "1",
			min_duration_ms: 5,
			max_duration_ms: 5000,
			deployment_env: "production",
			attribute_filter_key: "http.method",
			attribute_filter_value: "GET",
			resource_filter_key: "service.namespace",
			resource_filter_value: "core",
			limit: 25,
		},
		allCapabilities: true,
	},
	{
		pipe: "list_traces",
		label: "contains-match",
		params: { service: "ap", service_match_mode: "contains", span_name_match_mode: "contains" },
		allCapabilities: true,
	},
	{
		pipe: "span_hierarchy",
		label: "windowed",
		params: { trace_id: TRACE_ID, span_id: "00f067aa0ba902b7" },
	},
	{
		pipe: "span_hierarchy",
		label: "unwindowed",
		route: "span_hierarchy:full-scan",
		params: { trace_id: TRACE_ID, start_time: undefined, end_time: undefined },
	},
	{ pipe: "traces_duration_stats", label: "default", params: {} },
	{ pipe: "traces_facets", label: "default", params: {}, allCapabilities: true },
	{
		pipe: "traces_facets",
		label: "attribute-filtered",
		params: {
			attribute_filter_key: "http.method",
			attribute_filter_value: "GE",
			attribute_filter_value_match_mode: "contains",
			resource_filter_key: "host.name",
			resource_filter_value: "web",
		},
		allCapabilities: true,
	},
	{ pipe: "slow_traces", label: "default", params: { service: "api", deployment_env: "production" } },
	{ pipe: "span_search", label: "default", params: { search: "timeout" }, allCapabilities: true },
	{ pipe: "top_operations", label: "default", params: { service_name: "api", metric: "p95_duration" } },

	// NB: the pipe adapter never forwards `bucket_seconds` into the query opts,
	// so none of these can reach the annual service-overview rollup — see
	// `pipePathReachesAnnualRoute`. The annual route lives in the QuerySpec
	// fixtures below.
	{
		pipe: "custom_traces_timeseries",
		label: "root-only",
		params: { root_only: "1", bucket_seconds: 3600 },
	},
	{ pipe: "custom_traces_timeseries", label: "ungrouped", params: { bucket_seconds: 3600 } },
	{
		pipe: "custom_traces_timeseries",
		label: "grouped-by-service",
		params: { bucket_seconds: 60, group_by_service: "1" },
		allCapabilities: true,
	},
	{
		pipe: "custom_traces_timeseries",
		label: "grouped-by-attribute",
		params: { bucket_seconds: 300, group_by_attributes: "http.route,http.method" },
		allCapabilities: true,
	},
	{
		pipe: "custom_traces_timeseries",
		label: "errors-only",
		params: { root_only: "1", bucket_seconds: 3600, errors_only: "1" },
	},
	{ pipe: "custom_traces_breakdown", label: "by-service", params: { group_by_service: "1" } },
	{
		pipe: "custom_traces_breakdown",
		label: "by-attribute",
		params: { group_by_attribute: "http.route" },
		allCapabilities: true,
	},

	{ pipe: "list_logs", label: "default", params: {}, allCapabilities: true },
	{
		pipe: "list_logs",
		label: "searched",
		params: { search: "connection refused", severity: "ERROR", service: "api", trace_id: TRACE_ID },
		allCapabilities: true,
	},
	{ pipe: "logs_count", label: "default", params: {}, allCapabilities: true },
	{ pipe: "logs_count", label: "searched", params: { search: "timeout" }, allCapabilities: true },
	{ pipe: "logs_facets", label: "default", params: {}, allCapabilities: true },

	{ pipe: "error_rate_by_service", label: "default", params: {} },
	{ pipe: "service_overview", label: "default", params: {} },
	{
		pipe: "service_overview",
		label: "filtered",
		params: { environments: "production,staging", commit_shas: "abc123,def456" },
	},
	{
		pipe: "service_overview_compare",
		label: "default",
		params: {
			current_start_time: START_TIME,
			current_end_time: END_TIME,
			previous_start_time: "2025-12-30 10:30:00",
			previous_end_time: "2026-01-01 14:15:00",
		},
	},
	{ pipe: "services_facets", label: "default", params: {} },
	{
		pipe: "service_releases_timeline",
		label: "default",
		params: { service_name: "api", bucket_seconds: 300 },
	},
	{
		pipe: "service_apdex_time_series",
		label: "default",
		params: { service_name: "api", bucket_seconds: 60 },
	},
	{
		pipe: "service_apdex_time_series",
		label: "custom-threshold",
		params: { service_name: "api", bucket_seconds: 3600, apdex_threshold_ms: 250 },
	},
	{ pipe: "get_service_usage", label: "default", params: { service: "api" } },
	{
		pipe: "get_service_usage_compare",
		label: "default",
		params: {
			service: "api",
			current_start_time: START_TIME,
			current_end_time: END_TIME,
			previous_start_time: "2025-12-30 10:30:00",
			previous_end_time: "2026-01-01 14:15:00",
		},
	},
	{ pipe: "service_dependencies", label: "default", params: { deployment_env: "production" } },

	{ pipe: "errors_by_type", label: "default", params: {} },
	{ pipe: "errors_timeseries", label: "default", params: { fingerprint_hash: FINGERPRINT } },
	{ pipe: "errors_facets", label: "default", params: {} },
	{ pipe: "errors_summary", label: "default", params: {} },
	{ pipe: "error_detail_traces", label: "default", params: { fingerprint_hash: FINGERPRINT } },
	{ pipe: "error_issues", label: "default", params: {} },
	{ pipe: "error_issue_timeseries", label: "default", params: { fingerprint_hash: FINGERPRINT } },
	{ pipe: "error_issue_sample_traces", label: "default", params: { fingerprint_hash: FINGERPRINT } },
	{ pipe: "error_issue_environments", label: "default", params: { fingerprint_hash: FINGERPRINT } },

	{ pipe: "list_metrics", label: "default", params: {} },
	{ pipe: "metrics_summary", label: "default", params: {} },

	{ pipe: "span_attribute_keys", label: "default", params: {}, allCapabilities: true },
	{ pipe: "resource_attribute_keys", label: "default", params: {}, allCapabilities: true },
	{ pipe: "metric_attribute_keys", label: "default", params: {} },
	{
		pipe: "metric_attribute_keys",
		label: "metric-scoped",
		route: "metric_attribute_keys:scoped",
		params: { metric_name: "http.server.duration", metric_type: "histogram" },
	},
	{
		pipe: "span_attribute_values",
		label: "default",
		params: { attribute_key: "http.method" },
		allCapabilities: true,
	},
	{
		pipe: "resource_attribute_values",
		label: "default",
		params: { attribute_key: "service.namespace" },
		allCapabilities: true,
	},
	{ pipe: "metric_attribute_values", label: "default", params: { attribute_key: "http.route" } },
	{
		pipe: "metric_attribute_values",
		label: "metric-scoped",
		route: "metric_attribute_values:scoped",
		params: {
			attribute_key: "http.route",
			metric_name: "http.server.duration",
			metric_type: "histogram",
		},
	},
]

// Collection

export interface CatalogEntry {
	/** Stable identifier, e.g. `pipe:list_traces:filtered:bloom`. */
	readonly id: string
	readonly source: "pipe" | "query-spec" | "builder"
	readonly name: string
	readonly label: string
	readonly capabilityLabel: string
	readonly route: string | undefined
	readonly sql: string
	/** Normalized FNV-1a over literal-stripped SQL; equal fingerprints are one
	 *  shape, so the sweep DESCRIBEs each shape once. */
	readonly fingerprint: string
	/** Present when the SQL came from a compiled DSL query. Absent for raw-SQL
	 *  paths. `decodeRows` is what the 64-bit-int assertion exercises. */
	readonly compiled?: CompiledQuery<unknown>
	/** Sample values for output columns the row schema narrows beyond their
	 *  ClickHouse type — see `BuilderFixture.sampleValues`. */
	readonly sampleValues?: Readonly<Record<string, unknown>>
}

/**
 * Compile every fixture. Pure — no I/O, no warehouse. A fixture that throws
 * fails here rather than silently dropping out of the sweep.
 */
export function collectPipeCatalog(): ReadonlyArray<CatalogEntry> {
	const entries: Array<CatalogEntry> = []

	for (const fixture of pipeFixtures) {
		const variants = fixture.allCapabilities ? capabilityVariants : [capabilityVariants[0]!]
		for (const variant of variants) {
			const params = {
				org_id: ORG_ID,
				start_time: START_TIME,
				end_time: END_TIME,
				...fixture.params,
			} as Record<string, unknown> & { org_id: string }

			const lowered = compilePipeQuery(fixture.pipe, params as never, variant.capabilities)
			if (lowered === undefined) {
				throw new Error(
					`SQL catalog: compilePipeQuery returned undefined for "${fixture.pipe}" (${fixture.label}). ` +
						`The pipe is in warehouseQueries but has no dispatch arm.`,
				)
			}
			// The catalog wants a throw: a fixture that will not compile must fail
			// its test rather than drop silently out of the sweep.
			const compiled = Effect.runSync(lowered)
			entries.push({
				id: `pipe:${fixture.pipe}:${fixture.label}:${variant.label}`,
				source: "pipe",
				name: fixture.pipe,
				label: fixture.label,
				capabilityLabel: variant.label,
				route: fixture.route,
				sql: compiled.sql,
				fingerprint: fingerprintSql(compiled.sql),
				compiled,
			})
		}
	}

	return entries
}

// QuerySpec collection (dashboards, overview charts, the metrics explorer)
//
// The pipe registry is only half the product. Dashboards and the overview go
// through `QueryEngineService.execute`, and the two adapters do NOT agree:
// `pipeParamsToTracesTimeseriesOpts` never forwards `bucketSeconds` into the
// query opts, so `canUseAnnualServiceOverview` is unreachable from a pipe. The
// annual route — the one that shipped `NO_COMMON_TYPE` — exists ONLY on this
// path. A sweep built on pipes alone would have missed the outage entirely.

export interface QuerySpecFixture {
	readonly label: string
	readonly route?: string
	readonly query: QuerySpec
	readonly startTime?: string
	readonly endTime?: string
	readonly allCapabilities?: boolean
}

// Branded via their real constructors rather than cast — the fixtures are held
// to the same contract as the callers they stand in for.
const service = (name: string) => ServiceName.make(name)
const environment = (name: string) => DeploymentEnvironment.make(name)
const metric = (name: string) => MetricName.make(name)

const TRACES_FILTERS = { serviceName: service("api"), environments: [environment("production")] } as const
const METRICS_FILTERS = {
	metricName: metric("http.server.request.duration"),
	metricType: "histogram",
	serviceName: service("api"),
} as const

export const querySpecFixtures: ReadonlyArray<QuerySpecFixture> = [
	{
		label: "traces-timeseries-annual",
		route: "traces_timeseries:annual",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			allMetrics: true,
			bucketSeconds: 3600,
			filters: { ...TRACES_FILTERS, rootSpansOnly: true },
		},
	},
	{
		label: "traces-timeseries-annual-daily-buckets",
		route: "traces_timeseries:annual",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			allMetrics: true,
			bucketSeconds: 86400,
			filters: { rootSpansOnly: true },
		},
		startTime: "2025-11-01 00:00:00",
		endTime: "2025-11-25 00:00:00",
	},
	{
		// The services list's sparkline request, verbatim. Sub-hour bucket + a real
		// groupBy: before the minute tier existed this combination was rejected and
		// every services-list load scanned raw `traces`.
		label: "traces-timeseries-annual-minutely-grouped",
		route: "traces_timeseries:annual",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			allMetrics: true,
			bucketSeconds: 300,
			groupBy: ["service"],
			filters: { ...TRACES_FILTERS, rootSpansOnly: true },
		},
		startTime: SHORT_START_TIME,
		endTime: SHORT_END_TIME,
	},
	{
		// Hour-multiple bucket WITH a groupBy: all three tiers, and the group key
		// has to survive the three-way UNION with identical types on every branch.
		label: "traces-timeseries-annual-grouped-all-tiers",
		route: "traces_timeseries:annual",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			allMetrics: true,
			bucketSeconds: 3600,
			groupBy: ["service"],
			filters: { rootSpansOnly: true },
		},
	},
	{
		// `seriesLimit` was unreachable on this route until the groupBy predicate
		// was relaxed — `hasRealGroupBy` was always false. This is the
		// CTE-over-three-way-union that no fixture had ever executed.
		label: "traces-timeseries-annual-grouped-series-cap",
		route: "traces_timeseries:annual",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			allMetrics: true,
			bucketSeconds: 300,
			groupBy: ["service"],
			seriesLimit: 10,
			filters: { rootSpansOnly: true },
		},
		startTime: SHORT_START_TIME,
		endTime: SHORT_END_TIME,
	},
	{
		// The rejecting side of the predicate: `status_code` is aggregated away by
		// both rollups, so this must fall through to another route. Keeps
		// `canUseAnnualServiceOverview` covered in both directions.
		label: "traces-timeseries-annual-rejected-status-code",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			allMetrics: true,
			bucketSeconds: 3600,
			groupBy: ["status_code"],
			filters: { rootSpansOnly: true },
		},
	},
	{
		label: "traces-timeseries-aggregates-mv",
		route: "traces_timeseries:aggregates-mv",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			bucketSeconds: 3600,
			filters: TRACES_FILTERS,
		},
	},
	{
		label: "traces-timeseries-raw",
		route: "traces_timeseries:raw",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "p95_duration",
			bucketSeconds: 60,
			filters: TRACES_FILTERS,
		},
		startTime: SHORT_START_TIME,
		endTime: SHORT_END_TIME,
		allCapabilities: true,
	},
	{
		label: "traces-timeseries-all-metrics-grouped",
		route: "traces_timeseries:raw",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			allMetrics: true,
			bucketSeconds: 3600,
			groupBy: ["service"],
			filters: TRACES_FILTERS,
		},
	},
	{
		label: "traces-timeseries-apdex",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "apdex",
			apdexThresholdMs: 250,
			bucketSeconds: 300,
			filters: TRACES_FILTERS,
		},
	},
	{
		label: "traces-timeseries-series-cap",
		route: "traces_timeseries:series-cap",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "count",
			bucketSeconds: 300,
			groupBy: ["span_name"],
			seriesLimit: 10,
			filters: TRACES_FILTERS,
		},
	},
	{
		label: "traces-timeseries-attribute-filtered",
		query: {
			kind: "timeseries",
			source: "traces",
			metric: "error_rate",
			bucketSeconds: 300,
			filters: {
				...TRACES_FILTERS,
				attributeFilters: [{ key: "http.method", value: "GET", mode: "equals" }],
			},
		},
		allCapabilities: true,
	},

	{
		label: "logs-timeseries",
		query: {
			kind: "timeseries",
			source: "logs",
			metric: "count",
			bucketSeconds: 3600,
			filters: { serviceName: service("api") },
		},
		allCapabilities: true,
	},
	{
		label: "logs-timeseries-grouped",
		query: {
			kind: "timeseries",
			source: "logs",
			metric: "count",
			bucketSeconds: 60,
			groupBy: ["severity"],
			seriesLimit: 5,
		},
		startTime: SHORT_START_TIME,
		endTime: SHORT_END_TIME,
	},
	{
		label: "metrics-timeseries",
		query: {
			kind: "timeseries",
			source: "metrics",
			metric: "avg",
			bucketSeconds: 3600,
			filters: METRICS_FILTERS,
		},
	},
	{
		label: "metrics-timeseries-rate",
		query: {
			kind: "timeseries",
			source: "metrics",
			metric: "rate",
			bucketSeconds: 3600,
			filters: { metricName: metric("http.server.requests"), metricType: "sum" },
		},
	},
	{
		label: "metrics-timeseries-grouped-by-attribute",
		query: {
			kind: "timeseries",
			source: "metrics",
			metric: "sum",
			bucketSeconds: 300,
			groupBy: ["attribute"],
			filters: { ...METRICS_FILTERS, groupByAttributeKey: "http.route" },
		},
	},
	{
		label: "metrics-timeseries-grouped-by-resource",
		query: {
			kind: "timeseries",
			source: "metrics",
			metric: "avg",
			bucketSeconds: 300,
			groupBy: ["resource_attribute"],
			filters: { ...METRICS_FILTERS, groupByResourceAttributeKey: "host.name" },
		},
	},

	{
		label: "traces-breakdown",
		query: {
			kind: "breakdown",
			source: "traces",
			metric: "count",
			groupBy: "service",
			filters: TRACES_FILTERS,
		},
	},
	{
		label: "traces-breakdown-by-attribute",
		query: {
			kind: "breakdown",
			source: "traces",
			metric: "p99_duration",
			groupBy: "attribute",
			filters: { ...TRACES_FILTERS, groupByAttributeKeys: ["http.route"] },
		},
		allCapabilities: true,
	},
	{
		label: "logs-breakdown",
		query: {
			kind: "breakdown",
			source: "logs",
			metric: "count",
			groupBy: "severity",
			filters: { serviceName: service("api") },
		},
	},
	{
		label: "metrics-breakdown",
		query: {
			kind: "breakdown",
			source: "metrics",
			metric: "avg",
			groupBy: "service",
			filters: METRICS_FILTERS,
		},
	},
	{
		label: "metrics-sparklines",
		query: {
			kind: "sparklines",
			source: "metrics",
			metricType: "sum",
			metricNames: [metric("http.server.requests"), metric("rpc.server.duration")],
			bucketSeconds: 3600,
		},
	},

	{
		label: "traces-list",
		query: { kind: "list", source: "traces", limit: 50, filters: TRACES_FILTERS },
		allCapabilities: true,
	},
	{
		label: "traces-list-grouped",
		query: { kind: "list", source: "traces", groupByTrace: true, limit: 50, filters: TRACES_FILTERS },
		allCapabilities: true,
	},
	{
		// An attribute filter the MV cannot express — covers the raw-`traces`
		// stage-1 fallback of traceListQuery.
		label: "traces-list-grouped-attr-fallback",
		query: {
			kind: "list",
			source: "traces",
			groupByTrace: true,
			limit: 50,
			filters: {
				...TRACES_FILTERS,
				attributeFilters: [{ key: "user.id", value: "u1", mode: "equals" }],
			},
		},
		allCapabilities: true,
	},
	{
		label: "traces-list-grouped-duration-sort",
		query: {
			kind: "list",
			source: "traces",
			groupByTrace: true,
			limit: 50,
			offset: 100,
			sortBy: "durationMs",
			sortDir: "desc",
			filters: TRACES_FILTERS,
		},
	},
	// NB: `{kind: "list", source: "logs"}` is a declared QuerySpec variant that
	// `QueryEngineService.execute` does not implement — log lists only reach the
	// warehouse through the `list_logs` pipe, covered above.
	{
		label: "logs-count",
		query: { kind: "count", source: "logs", filters: { serviceName: service("api") } },
		allCapabilities: true,
	},
	{ label: "traces-stats", query: { kind: "stats", source: "traces", filters: TRACES_FILTERS } },

	{
		label: "traces-facets",
		query: { kind: "facets", source: "traces", filters: TRACES_FILTERS },
		allCapabilities: true,
	},
	{
		label: "traces-facets-single-dimension",
		route: "facets:single-dimension",
		query: { kind: "facets", source: "traces", facet: "spanName", filters: TRACES_FILTERS },
	},
	{
		label: "logs-facets",
		query: { kind: "facets", source: "logs", filters: { serviceName: service("api") } },
	},
	{
		label: "logs-facets-single-dimension",
		route: "facets:single-dimension",
		query: { kind: "facets", source: "logs", facet: "severity" },
	},
	{ label: "errors-facets", query: { kind: "facets", source: "errors" } },
	{ label: "services-facets", query: { kind: "facets", source: "services" } },

	{
		label: "attribute-keys-span",
		query: { kind: "attributeKeys", source: "traces", scope: "span" },
		allCapabilities: true,
	},
	{
		label: "attribute-keys-resource",
		query: { kind: "attributeKeys", source: "traces", scope: "resource" },
	},
	{ label: "attribute-keys-logs", query: { kind: "attributeKeys", source: "logs" } },
	{ label: "attribute-keys-metrics", query: { kind: "attributeKeys", source: "metrics" } },
	{
		label: "attribute-keys-metrics-scoped",
		route: "attribute_keys:metric-scoped",
		query: {
			kind: "attributeKeys",
			source: "metrics",
			metricName: metric("http.server.requests"),
			metricType: "sum",
		},
	},
	{
		label: "attribute-values-span",
		query: { kind: "attributeValues", source: "traces", scope: "span", attributeKey: "http.method" },
		allCapabilities: true,
	},
	{
		label: "attribute-values-log",
		query: { kind: "attributeValues", source: "logs", scope: "log", attributeKey: "log.level" },
	},
	{
		label: "attribute-values-metrics",
		query: { kind: "attributeValues", source: "metrics", scope: "metric", attributeKey: "http.route" },
	},
	{
		label: "attribute-values-metrics-scoped",
		route: "attribute_values:metric-scoped",
		query: {
			kind: "attributeValues",
			source: "metrics",
			scope: "metric",
			attributeKey: "http.route",
			metricName: metric("http.server.requests"),
			metricType: "sum",
		},
	},
]

interface CapturedSql {
	readonly sql: string
	readonly compiled?: CompiledQuery<unknown>
}

/**
 * A `QueryEngineWarehouse` that records SQL and returns no rows. Capture happens
 * before result shaping, so a fixture whose downstream shaping fails on an empty
 * result still contributes its SQL — the SQL is the artifact under test.
 */
function makeCapturingWarehouse(capabilities: WarehouseCapabilities): {
	readonly warehouse: QueryEngineWarehouse<QueryTenant>
	readonly captured: ReadonlyArray<CapturedSql>
} {
	const captured: Array<CapturedSql> = []
	const empty = Effect.succeed([] as ReadonlyArray<never>)
	const warehouse: QueryEngineWarehouse<QueryTenant> = {
		rawSqlQuery: (_tenant, sql) => {
			captured.push({ sql })
			return empty
		},
		compiledQuery: (_tenant, input) => {
			const compiled = compiledQueryOf(input)
			captured.push({ sql: compiled.sql, compiled: compiled as CompiledQuery<unknown> })
			return empty
		},
		compiledQueryWithCapabilities: (_tenant, compile) => {
			const compiled = Effect.runSync(compile(capabilities))
			captured.push({ sql: compiled.sql, compiled: compiled as CompiledQuery<unknown> })
			return empty
		},
	}
	return { warehouse, captured }
}

/**
 * Drive every QuerySpec fixture through the real lowering and collect the SQL it
 * would have executed.
 */
export function collectQuerySpecCatalog(): ReadonlyArray<CatalogEntry> {
	const entries: Array<CatalogEntry> = []
	const tenant: QueryTenant = { orgId: OrgId.make(ORG_ID) }

	for (const fixture of querySpecFixtures) {
		const variants = fixture.allCapabilities ? capabilityVariants : [capabilityVariants[0]!]
		for (const variant of variants) {
			const { warehouse, captured } = makeCapturingWarehouse(variant.capabilities)
			const execute = makeQueryEngineExecute(warehouse)
			const request = new QueryEngineExecuteRequest({
				startTime: fixture.startTime ?? START_TIME,
				endTime: fixture.endTime ?? END_TIME,
				query: fixture.query,
			})

			// Shaping errors on an empty result are irrelevant — the SQL is captured
			// before shaping. A fixture that captured nothing never reached the
			// warehouse at all, and the validation error explains why.
			const outcome = Effect.runSync(Effect.exit(execute(tenant, request)))

			if (captured.length === 0) {
				const reason = outcome._tag === "Failure" ? String(outcome.cause) : "no error reported"
				throw new Error(
					`SQL catalog: QuerySpec fixture "${fixture.label}" (${variant.label}) executed no query: ${reason}`,
				)
			}

			captured.forEach((capture, index) => {
				const suffix = captured.length > 1 ? `#${index + 1}` : ""
				entries.push({
					id: `spec:${fixture.label}${suffix}:${variant.label}`,
					source: "query-spec",
					name: `${fixture.query.source}.${fixture.query.kind}`,
					label: `${fixture.label}${suffix}`,
					capabilityLabel: variant.label,
					route: fixture.route,
					sql: capture.sql,
					fingerprint: fingerprintSql(capture.sql),
					...(capture.compiled ? { compiled: capture.compiled } : undefined),
				})
			})
		}
	}

	return entries
}

// Builder collection (direct `warehouse.compiledQuery` call sites)
//
// The pipe registry + QuerySpec lowering cover only ~36 of 161 exported query
// builders; the rest are compiled directly at call sites in apps/api and never
// met the analyzer. `builderFixtures` (ch/builder-fixtures.ts) enumerates them
// with production-shaped params; the e2e sweep picks these entries up with
// zero test changes because it iterates the catalog.

export function collectBuilderCatalog(): ReadonlyArray<CatalogEntry> {
	const entries: Array<CatalogEntry> = []
	for (const fixture of builderFixtures) {
		const compiled = fixture.compile()
		// The executor dies on unresolved placeholders at runtime; a fixture with a
		// missing compile param must fail HERE, in the unit test, not in the sweep.
		if (compiled.sql.includes("__PARAM_")) {
			throw new Error(
				`SQL catalog: builder fixture ${fixture.module}/${fixture.name} (${fixture.label}) ` +
					`left an unresolved __PARAM_ placeholder — a compile param is missing.`,
			)
		}
		entries.push({
			id: `builder:${fixture.module}:${fixture.name}:${fixture.label}`,
			source: "builder",
			name: fixture.name,
			label: fixture.label,
			capabilityLabel: "baseline",
			route: undefined,
			sql: compiled.sql,
			fingerprint: fingerprintSql(compiled.sql),
			compiled,
			...(fixture.sampleValues ? { sampleValues: fixture.sampleValues } : undefined),
		})
	}
	return entries
}

/** The full catalog: every SQL shape reachable from any entry surface. */
export function collectSqlCatalog(): ReadonlyArray<CatalogEntry> {
	return [...collectPipeCatalog(), ...collectQuerySpecCatalog(), ...collectBuilderCatalog()]
}

/** One entry per distinct SQL shape, keeping the first fixture that produced it. */
export function dedupeByFingerprint(entries: ReadonlyArray<CatalogEntry>): ReadonlyArray<CatalogEntry> {
	const seen = new Map<string, CatalogEntry>()
	for (const entry of entries) {
		if (!seen.has(entry.fingerprint)) seen.set(entry.fingerprint, entry)
	}
	return [...seen.values()]
}

// Anti-rot assertions

/**
 * Catalog entries whose rows nothing validates.
 *
 * `rowSchemaSource: "none"` means at least one selected expression had no type
 * to read — a `rawExpr` without a column type, a `dynamicColumn`, an
 * un-annotated custom function — so `decodeRows` degrades to an identity cast
 * and a warehouse that changes a column's wire format is invisible until the
 * value reaches a `Schema.Class` constructor several layers away.
 *
 * The allowlist below is asserted *exactly*, in both directions: a query that
 * stops deriving fails, and so does one still listed here after it starts.
 *
 * It is empty, and that is the invariant worth keeping: every SQL shape the
 * product can emit validates the rows it gets back. Adding an entry is how you
 * say a query cannot — and it needs a sentence here saying why.
 */
export const UNDECODED_QUERIES: ReadonlySet<string> = new Set([])

/** `source:name` for every catalog entry that decodes nothing. */
export function undecodedQueries(entries: ReadonlyArray<CatalogEntry>): ReadonlyArray<string> {
	const undecoded = new Set<string>()
	for (const entry of entries) {
		if (entry.compiled?.rowSchemaSource === "none") undecoded.add(`${entry.source}:${entry.name}`)
	}
	return [...undecoded].sort()
}

/**
 * The same list with the columns responsible, for the assertion's failure
 * message. Derivation is all-or-nothing, so "this query decodes nothing" is
 * useless on its own — these are the aliases to give a type.
 */
export function undecodedColumns(
	entries: ReadonlyArray<CatalogEntry>,
): ReadonlyMap<string, ReadonlyArray<string>> {
	const columns = new Map<string, ReadonlyArray<string>>()
	for (const entry of entries) {
		if (entry.compiled?.rowSchemaSource !== "none") continue
		const key = `${entry.source}:${entry.name}`
		if (!columns.has(key)) columns.set(key, entry.compiled.untypedColumns)
	}
	return columns
}

/** Pipe names in `warehouseQueries` that no fixture covers. */
export function uncoveredPipes(entries: ReadonlyArray<CatalogEntry>): ReadonlyArray<WarehouseQueryName> {
	const covered = new Set(entries.map((entry) => entry.name))
	return warehouseQueries.filter((name) => !covered.has(name))
}

/**
 * Routing predicates the fixture set must exercise **both ways**. A predicate
 * only ever seen true (or only false) means one whole SQL shape is untested —
 * which is what let the annual service-overview branch reach production
 * unexecuted.
 *
 * Keyed by predicate name; the value reports which sides the fixtures hit.
 */
export function routeCoverage(): ReadonlyMap<string, { true: number; false: number }> {
	const coverage = new Map<string, { true: number; false: number }>()
	const record = (name: string, value: boolean) => {
		const current = coverage.get(name) ?? { true: 0, false: 0 }
		if (value) current.true += 1
		else current.false += 1
		coverage.set(name, current)
	}

	for (const fixture of querySpecFixtures) {
		const query = fixture.query
		if (query.source !== "traces" || query.kind !== "timeseries") continue
		const filters = (query.filters ?? {}) as Record<string, unknown>
		record(
			"canUseAnnualServiceOverview",
			CH.canUseAnnualServiceOverview({
				metric: query.metric,
				needsSampling: true,
				allMetrics: query.allMetrics === true,
				groupBy: query.groupBy as ReadonlyArray<string> | undefined,
				bucketSeconds: query.bucketSeconds,
				apdexThresholdMs: query.apdexThresholdMs,
				rootOnly: filters.rootSpansOnly === true,
				errorsOnly: filters.errorsOnly === true,
				spanName: filters.spanName as string | undefined,
				attributeFilters: filters.attributeFilters as never,
				resourceAttributeFilters: filters.resourceAttributeFilters as never,
			}),
		)
	}

	// `useProductEvents` picks the page-view source: the `product_events` rollup, or raw
	// `session_events`. Read off the fixture labels rather than re-deriving it —
	// `webAnalyticsVariants` emits every web-analytics fixture in both variants
	// and suffixes the rollup one, so this records exactly what the baseline
	// contains. If someone adds a one-sided fixture by hand, this is what notices.
	for (const fixture of builderFixtures) {
		if (fixture.module !== "web-analytics") continue
		record("useProductEvents", fixture.label.endsWith("-rollup"))
	}

	return coverage
}

/**
 * The pipe adapter drops `bucketSeconds` on the floor
 * (`pipeParamsToTracesTimeseriesOpts` returns opts without it), so no pipe
 * request can satisfy the `>= 3600` clause and the annual rollup is unreachable
 * from the CLI/MCP surface — the same logical chart takes a different route
 * depending on which door it came through.
 *
 * Asserted rather than fixed: closing it is a routing change with its own
 * performance profile, and it deserves its own PR. This exists so that change is
 * a deliberate one — the assertion fails the moment the adapter starts
 * forwarding the bucket width.
 */
export function pipePathReachesAnnualRoute(): boolean {
	return collectPipeCatalog().some(
		(entry) => entry.name === "custom_traces_timeseries" && entry.sql.includes("service_overview_hourly"),
	)
}
