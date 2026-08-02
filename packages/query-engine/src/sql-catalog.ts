// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

import type { CompiledQuery } from "@maple-dev/clickhouse-builder"
import { warehouseQueries, type WarehouseQueryName } from "@maple/domain"
import { baselineWarehouseCapabilities, type WarehouseCapabilities } from "./capabilities"
import * as CH from "./ch"
import { compilePipeQuery } from "./ch/pipe-dispatch"
import { fingerprintSql } from "./execution/fingerprint"

// ---------------------------------------------------------------------------
// Fixture inputs
// ---------------------------------------------------------------------------

const ORG_ID = "org_sql_catalog"
/** A window that spans whole hours plus partial edges on both sides, so the
 *  edge-hour + rollup-interior union shapes both produce non-degenerate SQL. */
const START_TIME = "2026-01-01 10:30:00"
const END_TIME = "2026-01-03 14:15:00"

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
const FINGERPRINT = "a1b2c3d4e5f60718"

/**
 * At least one fixture per name in `warehouseQueries` — enforced by
 * `assertPipeCoverage`, so adding a pipe without a fixture breaks the build.
 */
export const pipeFixtures: ReadonlyArray<PipeFixture> = [
	// ----- Traces -----
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
	{ pipe: "span_hierarchy", label: "windowed", params: { trace_id: TRACE_ID, span_id: "00f067aa0ba902b7" } },
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

	// ----- Custom charts: the routed timeseries. -----
	// The annual route is the one that shipped `NO_COMMON_TYPE`. It needs
	// root_only + hourly buckets + no group-by/filters, and the negative fixtures
	// below hold the other two branches of the same function.
	{
		pipe: "custom_traces_timeseries",
		label: "annual-service-overview",
		route: "traces_timeseries:annual",
		params: { root_only: "1", bucket_seconds: 3600 },
	},
	{
		pipe: "custom_traces_timeseries",
		label: "aggregates-mv",
		route: "traces_timeseries:aggregates-mv",
		params: { bucket_seconds: 3600 },
	},
	{
		pipe: "custom_traces_timeseries",
		label: "raw-traces",
		route: "traces_timeseries:raw",
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
		label: "annual-blocked-by-filter",
		route: "traces_timeseries:raw",
		params: { root_only: "1", bucket_seconds: 3600, errors_only: "1" },
	},
	{ pipe: "custom_traces_breakdown", label: "by-service", params: { group_by_service: "1" } },
	{
		pipe: "custom_traces_breakdown",
		label: "by-attribute",
		params: { group_by_attribute: "http.route" },
		allCapabilities: true,
	},

	// ----- Logs -----
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

	// ----- Services -----
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

	// ----- Errors -----
	{ pipe: "errors_by_type", label: "default", params: {} },
	{ pipe: "errors_timeseries", label: "default", params: { fingerprint_hash: FINGERPRINT } },
	{ pipe: "errors_facets", label: "default", params: {} },
	{ pipe: "errors_summary", label: "default", params: {} },
	{ pipe: "error_detail_traces", label: "default", params: { fingerprint_hash: FINGERPRINT } },
	{ pipe: "error_issues", label: "default", params: {} },
	{ pipe: "error_issue_timeseries", label: "default", params: { fingerprint_hash: FINGERPRINT } },
	{ pipe: "error_issue_sample_traces", label: "default", params: { fingerprint_hash: FINGERPRINT } },

	// ----- Metrics -----
	{ pipe: "list_metrics", label: "default", params: {} },
	{ pipe: "metrics_summary", label: "default", params: {} },

	// ----- Attribute discovery -----
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

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface CatalogEntry {
	/** Stable identifier, e.g. `pipe:list_traces:filtered:bloom`. */
	readonly id: string
	readonly source: "pipe"
	readonly name: string
	readonly label: string
	readonly capabilityLabel: string
	readonly route: string | undefined
	readonly sql: string
	/** Normalized FNV-1a over literal-stripped SQL; equal fingerprints are one
	 *  shape, so the sweep DESCRIBEs each shape once. */
	readonly fingerprint: string
	readonly compiled: CompiledQuery<unknown>
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

			const compiled = compilePipeQuery(fixture.pipe, params as never, variant.capabilities)
			if (compiled === undefined) {
				throw new Error(
					`SQL catalog: compilePipeQuery returned undefined for "${fixture.pipe}" (${fixture.label}). ` +
						`The pipe is in warehouseQueries but has no dispatch arm.`,
				)
			}
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

/** One entry per distinct SQL shape, keeping the first fixture that produced it. */
export function dedupeByFingerprint(
	entries: ReadonlyArray<CatalogEntry>,
): ReadonlyArray<CatalogEntry> {
	const seen = new Map<string, CatalogEntry>()
	for (const entry of entries) {
		if (!seen.has(entry.fingerprint)) seen.set(entry.fingerprint, entry)
	}
	return [...seen.values()]
}

// ---------------------------------------------------------------------------
// Anti-rot assertions
// ---------------------------------------------------------------------------

/** Pipe names in `warehouseQueries` that no fixture covers. */
export function uncoveredPipes(
	entries: ReadonlyArray<CatalogEntry>,
): ReadonlyArray<WarehouseQueryName> {
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

	for (const fixture of pipeFixtures) {
		if (fixture.pipe !== "custom_traces_timeseries") continue
		const params = fixture.params
		const num = (key: string) => (params[key] != null ? Number(params[key]) : undefined)
		const groupBy: Array<string> = []
		if (params.group_by_service != null) groupBy.push("service")
		if (params.group_by_span_name != null) groupBy.push("span_name")
		if (params.group_by_status_code != null) groupBy.push("status_code")
		if (params.group_by_http_method != null) groupBy.push("http_method")
		if (params.group_by_attributes != null) groupBy.push("attribute")

		const opts: CH.TracesTimeseriesOpts = {
			metric: "count",
			needsSampling: true,
			allMetrics: true,
			groupBy,
			bucketSeconds: num("bucket_seconds"),
			apdexThresholdMs: num("apdex_threshold_ms") ?? 500,
			rootOnly: params.root_only != null,
			errorsOnly: params.errors_only != null,
		}
		record("canUseAnnualServiceOverview", CH.canUseAnnualServiceOverview(opts))
	}

	return coverage
}
