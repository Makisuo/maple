// ---------------------------------------------------------------------------
// Structured output types for MCP tools
// Each tool returns a discriminated union variant with typed data
// ---------------------------------------------------------------------------

export interface SystemHealthData {
  timeRange: { start: string; end: string }
  serviceCount: number
  totalSpans: number
  totalErrors: number
  errorRate: number
  affectedServicesCount: number
  affectedTracesCount: number
  latency: { p50Ms: number; p95Ms: number }
  topErrors: Array<{
    errorType: string
    count: number
    affectedServicesCount: number
  }>
  services: Array<{
    name: string
    throughput: number
    errorRate: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
  }>
  dataVolume?: Array<{
    name: string
    traces: number
    logs: number
    metrics: number
  }>
}

export interface TraceRow {
  traceId: string
  rootSpanName: string
  durationMs: number
  spanCount: number
  services: string[]
  hasError: boolean
  startTime?: string
  errorMessage?: string
}

export interface PaginationMeta {
  offset: number
  limit: number
  hasMore: boolean
  total?: number
  nextOffset?: number
}

export interface SearchTracesData {
  timeRange: { start: string; end: string }
  pagination?: PaginationMeta
  traces: TraceRow[]
}

export interface FindSlowTracesData {
  timeRange: { start: string; end: string }
  stats?: {
    p50Ms: number
    p95Ms: number
    minMs: number
    maxMs: number
  }
  traces: TraceRow[]
}

export interface ErrorTypeRow {
  errorType: string
  count: number
  affectedServicesCount: number
  lastSeen: string
}

export interface FindErrorsData {
  timeRange: { start: string; end: string }
  errors: ErrorTypeRow[]
}

export interface ErrorDetailTrace {
  traceId: string
  rootSpanName: string
  durationMs: number
  spanCount: number
  services: string[]
  startTime: string
  errorMessage?: string
  logs: Array<{
    timestamp: string
    severityText: string
    body: string
  }>
}

export interface ErrorDetailData {
  timeRange: { start: string; end: string }
  errorType: string
  traces: ErrorDetailTrace[]
}

export interface SpanNodeData {
  spanId: string
  parentSpanId: string
  spanName: string
  serviceName: string
  durationMs: number
  statusCode: string
  statusMessage: string
  attributes: Record<string, string>
  children: SpanNodeData[]
}

export interface InspectTraceData {
  traceId: string
  serviceCount: number
  spanCount: number
  rootDurationMs: number
  spans: SpanNodeData[]
  logs: Array<{
    timestamp: string
    severityText: string
    serviceName: string
    body: string
    spanId?: string
  }>
}

export interface LogRow {
  timestamp: string
  severityText: string
  serviceName: string
  body: string
  traceId?: string
  spanId?: string
}

export interface SearchLogsData {
  timeRange: { start: string; end: string }
  totalCount: number
  pagination?: PaginationMeta
  logs: LogRow[]
  filters?: {
    service?: string
    severity?: string
    search?: string
    traceId?: string
  }
}

export interface DiagnoseServiceData {
  serviceName: string
  timeRange: { start: string; end: string }
  health: {
    throughput: number
    errorRate: number
    errorCount: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
    apdex: number
  }
  topErrors: Array<{
    errorType: string
    count: number
  }>
  recentTraces: TraceRow[]
  recentLogs: LogRow[]
}

export interface MetricRow {
  metricName: string
  metricType: string
  serviceName: string
  metricUnit: string
  dataPointCount: number
}

export interface ListMetricsData {
  timeRange: { start: string; end: string }
  pagination?: PaginationMeta
  summary: Array<{
    metricType: string
    metricCount: number
    dataPointCount: number
  }>
  metrics: MetricRow[]
}

export interface QueryDataData {
  timeRange: { start: string; end: string }
  kind: string
  metric: string
  groupBy?: string
  decisions?: string[]
  result:
    | { kind: "timeseries"; data: Array<{ bucket: string; series: Record<string, number> }> }
    | { kind: "breakdown"; data: Array<{ name: string; value: number }> }
}

export interface ServiceMapEdge {
  sourceService: string
  targetService: string
  callCount: number
  errorCount: number
  avgDurationMs: number
  p95DurationMs: number
}

export interface ServiceMapData {
  timeRange: { start: string; end: string }
  edges: ServiceMapEdge[]
  serviceCount: number
}

// ---------------------------------------------------------------------------
// Alert rule types
// ---------------------------------------------------------------------------

export interface AlertRuleRow {
  id: string
  name: string
  enabled: boolean
  severity: string
  serviceName: string | null
  signalType: string
  comparator: string
  threshold: number
  windowMinutes: number
  destinationIds: string[]
  createdAt: string
  updatedAt: string
}

export interface ListAlertRulesData {
  rules: AlertRuleRow[]
  total: number
}

export interface CreateAlertRuleData {
  rule: AlertRuleRow
}

export interface AlertRuleDetailRow extends AlertRuleRow {
  serviceNames: string[]
  excludeServiceNames: string[]
  groupBy: string | null
  minimumSampleCount: number
  consecutiveBreachesRequired: number
  consecutiveHealthyRequired: number
  renotifyIntervalMinutes: number
  metricName: string | null
  metricType: string | null
  metricAggregation: string | null
  apdexThresholdMs: number | null
  queryDataSource: string | null
  queryAggregation: string | null
  queryWhereClause: string | null
}

export interface GetAlertRuleData {
  rule: AlertRuleDetailRow
}

// ---------------------------------------------------------------------------
// Alert incident types
// ---------------------------------------------------------------------------

export interface AlertIncidentRow {
  id: string
  ruleId: string
  ruleName: string
  serviceName: string | null
  signalType: string
  severity: string
  status: string
  threshold: number
  comparator: string
  firstTriggeredAt: string
  resolvedAt: string | null
  lastObservedValue: number | null
}

export interface ListAlertIncidentsData {
  incidents: AlertIncidentRow[]
  total: number
  openCount: number
  resolvedCount: number
}

// ---------------------------------------------------------------------------
// Dashboard types
// ---------------------------------------------------------------------------

export interface DashboardRow {
  id: string
  name: string
  description?: string
  tags?: string[]
  widgetCount: number
  createdAt: string
  updatedAt: string
}

export interface ListDashboardsData {
  dashboards: DashboardRow[]
  total: number
}

export interface GetDashboardData {
  dashboard: Record<string, unknown>
}

export interface CreateDashboardData {
  dashboard: DashboardRow
}

export interface UpdateDashboardData {
  dashboard: DashboardRow
}

// ---------------------------------------------------------------------------
// Compare periods types
// ---------------------------------------------------------------------------

export interface ComparePeriodsData {
  currentPeriod: { start: string; end: string }
  previousPeriod: { start: string; end: string }
  overall: {
    current: { totalSpans: number; totalErrors: number; errorRate: number }
    previous: { totalSpans: number; totalErrors: number; errorRate: number }
  }
  services: Array<{
    name: string
    current: { throughput: number; errorRate: number; p95Ms: number }
    previous: { throughput: number; errorRate: number; p95Ms: number }
  }>
}

// ---------------------------------------------------------------------------
// Explore attributes types
// ---------------------------------------------------------------------------

export interface ExploreAttributesData {
  source: string
  scope?: string
  key?: string
  timeRange: { start: string; end: string }
  keys?: Array<{ key: string; count: number }>
  values?: Array<{ value: string; count: number }>
}

// ---------------------------------------------------------------------------
// List services types
// ---------------------------------------------------------------------------

export interface ListServicesData {
  timeRange: { start: string; end: string }
  total: number
  services: Array<{
    name: string
    throughput: number
    errorRate: number
    p95Ms: number
  }>
}

// ---------------------------------------------------------------------------
// Get service top operations types
// ---------------------------------------------------------------------------

export interface GetServiceTopOperationsData {
  timeRange: { start: string; end: string }
  serviceName: string
  metric: string
  total: number
  operations: Array<{
    name: string
    value: number
  }>
}

// ---------------------------------------------------------------------------
// Get incident timeline types
// ---------------------------------------------------------------------------

export interface IncidentTimelineRow {
  id: string
  ruleId: string
  ruleName: string
  serviceName: string | null
  signalType: string
  severity: string
  status: string
  comparator: string
  threshold: number
  lastObservedValue: number | null
  firstTriggeredAt: string
  lastTriggeredAt: string
  resolvedAt: string | null
  lastNotifiedAt: string | null
}

export interface GetIncidentTimelineData {
  incidents: IncidentTimelineRow[]
  total: number
  openCount: number
  resolvedCount: number
}

export type StructuredToolOutput =
  | { tool: "search_traces"; data: SearchTracesData }
  | { tool: "find_slow_traces"; data: FindSlowTracesData }
  | { tool: "find_errors"; data: FindErrorsData }
  | { tool: "error_detail"; data: ErrorDetailData }
  | { tool: "inspect_trace"; data: InspectTraceData }
  | { tool: "search_logs"; data: SearchLogsData }
  | { tool: "diagnose_service"; data: DiagnoseServiceData }
  | { tool: "list_metrics"; data: ListMetricsData }
  | { tool: "query_data"; data: QueryDataData }
  | { tool: "service_map"; data: ServiceMapData }
  | { tool: "list_alert_rules"; data: ListAlertRulesData }
  | { tool: "list_alert_incidents"; data: ListAlertIncidentsData }
  | { tool: "create_alert_rule"; data: CreateAlertRuleData }
  | { tool: "get_alert_rule"; data: GetAlertRuleData }
  | { tool: "list_dashboards"; data: ListDashboardsData }
  | { tool: "get_dashboard"; data: GetDashboardData }
  | { tool: "create_dashboard"; data: CreateDashboardData }
  | { tool: "update_dashboard"; data: UpdateDashboardData }
  | { tool: "compare_periods"; data: ComparePeriodsData }
  | { tool: "explore_attributes"; data: ExploreAttributesData }
  | { tool: "list_services"; data: ListServicesData }
  | { tool: "get_service_top_operations"; data: GetServiceTopOperationsData }
  | { tool: "get_incident_timeline"; data: GetIncidentTimelineData }
