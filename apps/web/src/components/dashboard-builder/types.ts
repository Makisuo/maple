// ---------------------------------------------------------------------------
// Dashboard Type System
// ---------------------------------------------------------------------------

// --- Time Range ---

export type TimeRange =
  | { type: "relative"; value: string }
  | { type: "absolute"; startTime: string; endTime: string }

// --- Data Source Endpoints ---

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

// --- Widget Data Source ---

export interface WidgetDataSource {
  endpoint: DataSourceEndpoint
  params?: Record<string, unknown>
  transform?: {
    fieldMap?: Record<string, string>
    flattenSeries?: {
      valueField: string
    }
    reduceToValue?: {
      field: string
      aggregate?: "sum" | "first" | "count" | "avg" | "max" | "min"
    }
    computeRatio?: {
      numeratorName: string
      denominatorNames: string[]
    }
    limit?: number
    sortBy?: { field: string; direction: "asc" | "desc" }
  }
}

// --- Widget Display ---

export type ValueUnit =
  | "none"
  | "number"
  | "percent"
  | "duration_ms"
  | "duration_us"
  | "bytes"
  | "requests_per_sec"
  | "short"
  | (string & {})

export interface WidgetDisplayConfig {
  title?: string
  description?: string

  // Chart-specific
  chartId?: string
  chartPresentation?: {
    legend?: "visible" | "hidden"
    tooltip?: "visible" | "hidden"
  }
  xAxis?: { label?: string; unit?: ValueUnit; visible?: boolean }
  yAxis?: {
    label?: string
    unit?: ValueUnit
    min?: number
    max?: number
    visible?: boolean
  }
  seriesMapping?: Record<string, string>
  colorOverrides?: Record<string, string>
  stacked?: boolean
  curveType?: "linear" | "monotone"

  // Stat-specific
  unit?: ValueUnit
  thresholds?: Array<{ value: number; color: string; label?: string }>
  prefix?: string
  suffix?: string
  sparkline?: { enabled: boolean; dataSource?: WidgetDataSource }

  // Table-specific
  columns?: Array<{
    field: string
    header: string
    unit?: ValueUnit
    width?: number
    align?: "left" | "center" | "right"
  }>

  // List-specific
  listDataSource?: "traces" | "logs"
  listWhereClause?: string
  listLimit?: number
}

// --- Widget Layout ---

export interface WidgetLayout {
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
  maxW?: number
  maxH?: number
}

// --- Visualization ---

export type VisualizationType = "chart" | "stat" | "table" | "list" | (string & {})
export type WidgetMode = "view" | "edit"
export type WidgetDataState =
  | { status: "loading" }
  | { status: "error"; message?: string }
  | { status: "ready"; data: unknown }

// --- Dashboard Widget ---

export interface DashboardWidget {
  id: string
  visualization: VisualizationType
  dataSource: WidgetDataSource
  display: WidgetDisplayConfig
  layout: WidgetLayout
}

// --- Dashboard ---

export interface Dashboard {
  id: string
  name: string
  description?: string
  tags?: string[]
  timeRange: TimeRange
  widgets: DashboardWidget[]
  createdAt: string
  updatedAt: string
}
