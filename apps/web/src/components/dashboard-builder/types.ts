// Widget shapes derive from @maple/domain; only web-only registry and render state lives here.

import type {
	DashboardRefreshIntervalSeconds,
	DashboardSectionSchema,
	DashboardVariableSchema,
	DashboardWidgetSchema,
	WidgetDataSourceSchema,
	WidgetDisplayConfigSchema,
	WidgetLayoutSchema,
	WidgetVisualization,
} from "@maple/domain/http"

// The domain schemas decode to deeply-readonly types; web widgets are mutable
// React/builder state, so the derived types are unwrapped to mutable form.
//
// `dataSource` is the one exception, wherever it appears (a widget's own, and
// the one `display.sparkline` embeds). A data source is always replaced
// wholesale, never edited field-by-field, so it stays readonly — which is what
// lets the constructors in `@maple/widgets/dashboard` be assigned straight into
// these types instead of every call site fighting a variance mismatch.
type DeepMutable<T> =
	T extends ReadonlyArray<infer U>
		? Array<DeepMutable<U>>
		: T extends object
			? { -readonly [K in keyof T]: K extends "dataSource" ? T[K] : DeepMutable<T[K]> }
			: T

// Deliberately NOT `@maple/query-model`'s `TimeRange`, which brands its ISO
// strings. Every producer in the UI (the time-range picker, the builder form)
// deals in plain strings; branding happens once, at the store's document
// boundary — the same reason `DashboardWidget["timeRange"]` is re-typed below.
export type TimeRange =
	| { type: "relative"; value: string }
	| { type: "absolute"; startTime: string; endTime: string }

export type DataSourceEndpoint =
	| "service_usage"
	| "service_overview"
	| "service_overview_time_series"
	| "service_apdex_time_series"
	| "services_facets"
	| "list_traces"
	| "traces_facets"
	| "traces_duration_stats"
	| "list_logs"
	| "logs_count"
	| "logs_facets"
	| "errors_summary"
	| "errors_by_type"
	| "error_detail_traces"
	| "errors_facets"
	| "error_rate_by_service"
	| "list_metrics"
	| "metrics_summary"
	| "custom_timeseries"
	| "custom_breakdown"
	| "custom_query_builder_timeseries"
	| "custom_query_builder_breakdown"
	| "custom_query_builder_list"
	| "raw_sql_chart"
	| "markdown_static"

// `endpoint` is narrowed to the registry key union so the data-source registry
// stays statically indexable; everything else comes straight from the schema.
//
// Deliberately NOT `DeepMutable`, unlike the display/layout aliases below. A
// data source is replaced wholesale — the builder never edits one field of it in
// place — and keeping it readonly is what lets the constructors in
// `@maple/widgets/dashboard` (which return the schema type) be assigned here
// directly, instead of every call site fighting a variance mismatch.
export type WidgetDataSource = Omit<typeof WidgetDataSourceSchema.Type, "endpoint"> & {
	endpoint: DataSourceEndpoint
}

export type ValueUnit =
	| "none"
	| "number"
	| "percent"
	| "percent_100"
	| "duration_ms"
	| "duration_us"
	| "duration_s"
	| "duration_ns"
	| "bytes"
	| "requests_per_sec"
	| "short"
	| (string & {})

export type WidgetDisplayConfig = DeepMutable<typeof WidgetDisplayConfigSchema.Type>

export type WidgetLayout = DeepMutable<typeof WidgetLayoutSchema.Type>

/**
 * The persisted `visualization` values this build knows how to render. Derived
 * from the shared widget-type table, so it can't drift from the registry.
 *
 * Closed on purpose — the old `| (string & {})` escape hatch defeated
 * exhaustiveness checking everywhere. Documents can still carry an unknown
 * string (an older client reading a newer dashboard); `widgetTypeFor` handles
 * that at the one boundary where it happens, rather than every type position
 * pretending it might.
 */
export type VisualizationType = WidgetVisualization
export type WidgetMode = "view" | "edit"
/**
 * `range` is a constraint rather than a failure: the tile's query kind can't
 * span the requested window (list widgets cap out well below charts), so it
 * renders a muted explanation with a one-click narrowing instead of a red
 * error block — and never issues the doomed request in the first place.
 */
type WidgetErrorKind = "decode" | "runtime" | "range"
export type WidgetDataState =
	| { status: "loading" }
	| { status: "error"; title?: string; message?: string; kind?: WidgetErrorKind }
	| { status: "ready"; data: unknown }

// `timeRange` is re-typed for the same reason `Dashboard["timeRange"]` is: the
// schema brands its ISO strings, and every producer in the UI (the time-range
// picker, the builder form) deals in plain strings. Branding happens once, at
// the store's document boundary.
export type DashboardWidget = Omit<
	DeepMutable<typeof DashboardWidgetSchema.Type>,
	"dataSource" | "timeRange"
> & {
	dataSource: WidgetDataSource
	/** Absent means the widget follows the dashboard's range. */
	timeRange?: TimeRange
}

export type DashboardVariable = DeepMutable<typeof DashboardVariableSchema.Type>

export type DashboardSection = DeepMutable<typeof DashboardSectionSchema.Type>
export type DashboardSectionTab = DashboardSection["tabs"][number]

export interface Dashboard {
	id: string
	name: string
	description?: string
	tags?: string[]
	timeRange: TimeRange
	widgets: DashboardWidget[]
	/**
	 * Collapsible widget groups. Absent means one flat canvas — every widget sits
	 * on the root grid, which is exactly how every pre-sections dashboard reads.
	 */
	sections?: DashboardSection[]
	variables?: DashboardVariable[]
	/** Auto-refresh cadence in seconds. Absent or `0` means off. */
	refreshIntervalSeconds?: DashboardRefreshIntervalSeconds
	createdAt: string
	updatedAt: string
}
