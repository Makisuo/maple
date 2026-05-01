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
	resourceAttributes?: Record<string, string>
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
	resourceAttributes: Record<string, string>
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

export interface MineLogPatternsPattern {
	template: string
	count: number
	sample: string
	severityCounts: Record<string, number>
	serviceCounts: Record<string, number>
}

export interface MineLogPatternsData {
	timeRange: { start: string; end: string }
	totalSampled: number
	sampleSize: number
	patterns: MineLogPatternsPattern[]
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
	isMonotonic: boolean
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

export interface QueryDataQueryContext {
	source: "traces" | "logs" | "metrics"
	serviceName?: string
	spanName?: string
	rootSpansOnly?: boolean
	environments?: string[]
	commitShas?: string[]
	severity?: string
	metricName?: string
	metricType?: string
	attributeFilters?: Array<{ key: string; value?: string; mode: string }>
	apdexThresholdMs?: number
	bucketSeconds?: number
	limit?: number
}

export type QueryDataUnit =
	| "duration_ms"
	| "duration_us"
	| "duration_s"
	| "duration_ns"
	| "percent"
	| "number"
	| "bytes"
	| "requests_per_sec"

export interface QueryDataData {
	timeRange: { start: string; end: string }
	kind: string
	metric: string
	groupBy?: string
	decisions?: string[]
	queryContext: QueryDataQueryContext
	unit: QueryDataUnit
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
	serviceNames: string[]
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
	groupBy: string[] | null
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
	groupKey: string | null
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

export interface AlertCheckRow {
	timestamp: string
	groupKey: string
	status: string
	observedValue: number | null
	threshold: number
	comparator: string
	sampleCount: number
	windowStart: string
	windowEnd: string
	consecutiveBreaches: number
	consecutiveHealthy: number
	incidentId: string | null
	incidentTransition: string
	evaluationDurationMs: number
}

export interface ListAlertChecksData {
	ruleId: string
	total: number
	breached: number
	healthy: number
	skipped: number
	transitions: number
	checks: AlertCheckRow[]
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

export interface AddDashboardWidgetData {
	dashboard: DashboardRow
	widgetId: string
}

export interface UpdateDashboardWidgetData {
	dashboard: DashboardRow
	widgetId: string
}

export interface RemoveDashboardWidgetData {
	dashboard: DashboardRow
	removedWidgetId: string
}

export interface ReorderDashboardWidgetsData {
	dashboard: DashboardRow
	updatedWidgetIds: string[]
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
	groupKey: string | null
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

// ---------------------------------------------------------------------------
// Inspect chart data types
// ---------------------------------------------------------------------------

export type InspectChartFlag =
	| "EMPTY"
	| "ALL_NULLS"
	| "ALL_ZEROS"
	| "SINGLE_POINT"
	| "FLAT_LINE"
	| "SUSPICIOUS_GAP"
	| "NEGATIVE_VALUES"
	| "UNREALISTIC_MAGNITUDE"
	| "SINGLE_SERIES_DOMINATES"
	| "CARDINALITY_EXPLOSION"
	| "UNIT_MISMATCH"
	| "BROKEN_BREAKDOWN"

export type InspectChartVerdict = "looks_healthy" | "suspicious" | "broken"

export interface InspectChartSeriesSample {
	bucket?: string
	value: number | null
}

export interface InspectChartSeriesStat {
	name: string
	min: number | null
	max: number | null
	avg: number | null
	validCount: number
	nullCount: number
	zeroCount: number
	negativeCount: number
	samples: InspectChartSeriesSample[]
}

export interface InspectChartQueryStats {
	rowCount: number
	seriesCount: number
	firstBucket?: string
	lastBucket?: string
	seriesStats: InspectChartSeriesStat[]
}

export interface InspectChartQueryResult {
	queryId: string
	queryName: string
	status: "ok" | "error" | "skipped"
	error?: string
	spec?: unknown
	stats: InspectChartQueryStats
	reducedValue?: number | null
	flags: InspectChartFlag[]
}

export interface InspectChartDataData {
	widget: {
		id: string
		title?: string
		visualization: string
		endpoint: string
		displayUnit?: string
		hasFormulaWarning: boolean
		hasUnsupportedTransform: boolean
	}
	timeRange: {
		startTime: string
		endTime: string
		source: "override" | "dashboard" | "fallback"
	}
	queries: InspectChartQueryResult[]
	verdict: InspectChartVerdict
	flags: InspectChartFlag[]
	notes: string[]
}

export interface ActorSummary {
	id: string
	type: "user" | "agent"
	userId: string | null
	agentName: string | null
	model: string | null
	capabilities: ReadonlyArray<string>
}

export interface ErrorIssueRow {
	id: string
	fingerprintHash: string
	workflowState: string
	priority: number
	serviceName: string
	exceptionType: string
	exceptionMessage: string
	topFrame: string
	occurrenceCount: number
	firstSeenAt: string
	lastSeenAt: string
	assignedActor: ActorSummary | null
	leaseHolder: ActorSummary | null
	leaseExpiresAt: string | null
	notes: string | null
	hasOpenIncident: boolean
}

export interface ListErrorIssuesData {
	issues: ErrorIssueRow[]
	total: number
}

export interface TransitionErrorIssueData {
	id: string
	workflowState: string
	fromState: string
	toState: string
	assignedActorId: string | null
	leaseHolderActorId: string | null
	snoozeUntil: string | null
}

export interface ClaimErrorIssueData {
	id: string
	workflowState: string
	leaseHolderActorId: string
	leaseExpiresAt: string
	claimedAt: string
}

export interface ReleaseErrorIssueData {
	id: string
	workflowState: string
	previousLeaseHolderActorId: string | null
}

export interface HeartbeatErrorIssueData {
	id: string
	leaseExpiresAt: string
}

export interface CommentOnErrorIssueData {
	eventId: string
	issueId: string
	type: "comment" | "agent_note"
	actorId: string | null
}

export interface ProposeFixData {
	issueId: string
	workflowState: string
	eventId: string
	prUrl: string | null
}

export interface ListErrorIssueEventsData {
	issueId: string
	events: Array<{
		id: string
		type: string
		fromState: string | null
		toState: string | null
		actorId: string | null
		createdAt: string
		payload: Record<string, unknown>
	}>
	total: number
}

export interface RegisterAgentData {
	id: string
	agentName: string | null
	model: string | null
	capabilities: ReadonlyArray<string>
}

export interface ErrorIncidentRow {
	id: string
	issueId: string
	status: string
	reason: string
	firstTriggeredAt: string
	lastTriggeredAt: string
	resolvedAt: string | null
	occurrenceCount: number
}

export interface ListErrorIncidentsData {
	incidents: ErrorIncidentRow[]
	total: number
	openCount: number
}

export interface UpdateErrorNotificationPolicyData {
	enabled: boolean
	destinationIds: ReadonlyArray<string>
	notifyOnFirstSeen: boolean
	notifyOnRegression: boolean
	notifyOnResolve: boolean
	minOccurrenceCount: number
	severity: string
}

export type StructuredToolOutput =
	| { tool: "search_traces"; data: SearchTracesData }
	| { tool: "find_slow_traces"; data: FindSlowTracesData }
	| { tool: "find_errors"; data: FindErrorsData }
	| { tool: "error_detail"; data: ErrorDetailData }
	| { tool: "inspect_trace"; data: InspectTraceData }
	| { tool: "search_logs"; data: SearchLogsData }
	| { tool: "mine_log_patterns"; data: MineLogPatternsData }
	| { tool: "diagnose_service"; data: DiagnoseServiceData }
	| { tool: "list_metrics"; data: ListMetricsData }
	| { tool: "query_data"; data: QueryDataData }
	| { tool: "service_map"; data: ServiceMapData }
	| { tool: "list_alert_rules"; data: ListAlertRulesData }
	| { tool: "list_alert_incidents"; data: ListAlertIncidentsData }
	| { tool: "list_alert_checks"; data: ListAlertChecksData }
	| { tool: "create_alert_rule"; data: CreateAlertRuleData }
	| { tool: "get_alert_rule"; data: GetAlertRuleData }
	| { tool: "list_dashboards"; data: ListDashboardsData }
	| { tool: "get_dashboard"; data: GetDashboardData }
	| { tool: "create_dashboard"; data: CreateDashboardData }
	| { tool: "update_dashboard"; data: UpdateDashboardData }
	| { tool: "add_dashboard_widget"; data: AddDashboardWidgetData }
	| { tool: "update_dashboard_widget"; data: UpdateDashboardWidgetData }
	| { tool: "remove_dashboard_widget"; data: RemoveDashboardWidgetData }
	| { tool: "reorder_dashboard_widgets"; data: ReorderDashboardWidgetsData }
	| { tool: "compare_periods"; data: ComparePeriodsData }
	| { tool: "explore_attributes"; data: ExploreAttributesData }
	| { tool: "list_services"; data: ListServicesData }
	| { tool: "get_service_top_operations"; data: GetServiceTopOperationsData }
	| { tool: "get_incident_timeline"; data: GetIncidentTimelineData }
	| { tool: "inspect_chart_data"; data: InspectChartDataData }
	| { tool: "list_error_issues"; data: ListErrorIssuesData }
	| { tool: "transition_error_issue"; data: TransitionErrorIssueData }
	| { tool: "claim_error_issue"; data: ClaimErrorIssueData }
	| { tool: "release_error_issue"; data: ReleaseErrorIssueData }
	| { tool: "heartbeat_error_issue"; data: HeartbeatErrorIssueData }
	| { tool: "comment_on_error_issue"; data: CommentOnErrorIssueData }
	| { tool: "propose_fix"; data: ProposeFixData }
	| { tool: "list_error_issue_events"; data: ListErrorIssueEventsData }
	| { tool: "register_agent"; data: RegisterAgentData }
	| { tool: "list_error_incidents"; data: ListErrorIncidentsData }
	| {
			tool: "update_error_notification_policy"
			data: UpdateErrorNotificationPolicyData
	  }
