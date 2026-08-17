/**
 * The named-query registry: the canonical set of pipe names that
 * `compilePipeQuery` (in `@maple/query-engine`) lowers to ClickHouse SQL. This
 * is a cross-binary wire contract — it backs `WarehouseExecutor.query(pipe, …)`
 * and the `/local/query` payload the CLI sends in local mode. Treat it as
 * additive: only append new names; renaming/removing a name is a breaking
 * change for already-shipped CLI binaries.
 *
 * It is no longer an HTTP contract: the CLI's remote mode calls the public v2
 * API instead of naming pipes over the wire.
 *
 * NB: alert evaluation does NOT go through this registry — it uses the
 * structured `QuerySpec` → `QueryEngineService.evaluate` path instead.
 */
export const warehouseQueries = [
	"list_traces",
	"span_hierarchy",
	"list_logs",
	"logs_count",
	"logs_facets",
	"error_rate_by_service",
	"get_service_usage",
	"get_service_usage_compare",
	"list_metrics",
	"metrics_summary",
	"traces_facets",
	"traces_duration_stats",
	"service_overview",
	"service_overview_compare",
	"services_facets",
	"service_releases_timeline",
	"errors_by_type",
	"error_detail_traces",
	"errors_facets",
	"errors_summary",
	"errors_timeseries",
	"error_issues",
	"error_issue_timeseries",
	"error_issue_sample_traces",
	"service_apdex_time_series",
	"custom_traces_timeseries",
	"custom_traces_breakdown",
	"top_operations",
	"slow_traces",
	"span_search",
	"service_dependencies",
	"metric_attribute_keys",
	"span_attribute_keys",
	"span_attribute_values",
	"resource_attribute_keys",
	"resource_attribute_values",
	"metric_attribute_values",
] as const

export type WarehouseQueryName = (typeof warehouseQueries)[number]
