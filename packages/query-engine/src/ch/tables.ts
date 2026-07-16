// ---------------------------------------------------------------------------
// Maple Table Definitions
//
// Derived from packages/domain/src/tinybird/datasources.ts
// These define the ClickHouse table schemas used by the query DSL.
// ---------------------------------------------------------------------------

import * as T from "@maple-dev/clickhouse-builder/types"
import { table } from "@maple-dev/clickhouse-builder"

export const Traces = table("traces", {
	OrgId: T.string,
	Timestamp: T.dateTime64,
	TraceId: T.string,
	SpanId: T.string,
	ParentSpanId: T.string,
	TraceState: T.string,
	SpanName: T.string,
	SpanKind: T.string,
	ServiceName: T.string,
	ResourceSchemaUrl: T.string,
	ResourceAttributes: T.map(T.string, T.string),
	ScopeSchemaUrl: T.string,
	ScopeName: T.string,
	ScopeVersion: T.string,
	ScopeAttributes: T.map(T.string, T.string),
	Duration: T.uint64,
	StatusCode: T.string,
	StatusMessage: T.string,
	SpanAttributes: T.map(T.string, T.string),
	EventsTimestamp: T.array(T.dateTime64),
	EventsName: T.array(T.string),
	EventsAttributes: T.array(T.map(T.string, T.string)),
	LinksTraceId: T.array(T.string),
	LinksSpanId: T.array(T.string),
	LinksTraceState: T.array(T.string),
	LinksAttributes: T.array(T.map(T.string, T.string)),
	SampleRate: T.float64,
	IsEntryPoint: T.uint8,
})

export const TraceDetailSpans = table("trace_detail_spans", {
	OrgId: T.string,
	Timestamp: T.dateTime64,
	TraceId: T.string,
	SpanId: T.string,
	ParentSpanId: T.string,
	SpanName: T.string,
	SpanKind: T.string,
	ServiceName: T.string,
	Duration: T.uint64,
	StatusCode: T.string,
	StatusMessage: T.string,
	SpanAttributes: T.map(T.string, T.string),
	ResourceAttributes: T.map(T.string, T.string),
	EventsTimestamp: T.array(T.dateTime64),
	EventsName: T.array(T.string),
	EventsAttributes: T.array(T.map(T.string, T.string)),
})

export const TraceListMv = table("trace_list_mv", {
	OrgId: T.string,
	TraceId: T.string,
	Timestamp: T.dateTime,
	ServiceName: T.string,
	SpanName: T.string,
	SpanKind: T.string,
	Duration: T.uint64,
	StatusCode: T.string,
	HttpMethod: T.string,
	HttpRoute: T.string,
	HttpStatusCode: T.string,
	DeploymentEnv: T.string,
	ServiceNamespace: T.string,
	HasError: T.uint8,
	TraceState: T.string,
})

export const Logs = table("logs", {
	OrgId: T.string,
	Timestamp: T.dateTime64,
	TimestampTime: T.dateTime,
	TraceId: T.string,
	SpanId: T.string,
	TraceFlags: T.uint8,
	SeverityText: T.string,
	SeverityNumber: T.uint8,
	ServiceName: T.string,
	Body: T.string,
	ResourceSchemaUrl: T.string,
	ResourceAttributes: T.map(T.string, T.string),
	ScopeSchemaUrl: T.string,
	ScopeName: T.string,
	ScopeVersion: T.string,
	ScopeAttributes: T.map(T.string, T.string),
	LogAttributes: T.map(T.string, T.string),
})

export const ServiceOverviewSpans = table("service_overview_spans", {
	OrgId: T.string,
	Timestamp: T.dateTime,
	ServiceName: T.string,
	Duration: T.uint64,
	StatusCode: T.string,
	TraceState: T.string,
	DeploymentEnv: T.string,
	ServiceNamespace: T.string,
	CommitSha: T.string,
	SampleRate: T.float64,
})

export const ErrorSpans = table("error_spans", {
	OrgId: T.string,
	Timestamp: T.dateTime,
	TraceId: T.string,
	SpanId: T.string,
	ParentSpanId: T.string,
	ServiceName: T.string,
	StatusMessage: T.string,
	Duration: T.uint64,
	DeploymentEnv: T.string,
})

export const ErrorEvents = table("error_events", {
	OrgId: T.string,
	Timestamp: T.dateTime,
	TraceId: T.string,
	SpanId: T.string,
	ParentSpanId: T.string,
	ServiceName: T.string,
	DeploymentEnv: T.string,
	ExceptionType: T.string,
	ExceptionMessage: T.string,
	ExceptionStacktrace: T.string,
	TopFrame: T.string,
	FingerprintHash: T.uint64,
	StatusMessage: T.string,
	Duration: T.uint64,
	ErrorLabel: T.string,
})

/**
 * Time-ordered sibling of `error_events` (same rows, sorted by Timestamp instead of
 * FingerprintHash). Use for recent-window scans that filter a Timestamp range and
 * group across fingerprints (e.g. the errorIssuesScan tick); use `ErrorEvents` for
 * per-fingerprint occurrence lookups. See `errorEventsByTime` in
 * `packages/domain/src/tinybird/datasources.ts`.
 */
export const ErrorEventsByTime = table("error_events_by_time", {
	OrgId: T.string,
	Timestamp: T.dateTime,
	TraceId: T.string,
	SpanId: T.string,
	ParentSpanId: T.string,
	ServiceName: T.string,
	DeploymentEnv: T.string,
	ExceptionType: T.string,
	ExceptionMessage: T.string,
	ExceptionStacktrace: T.string,
	TopFrame: T.string,
	FingerprintHash: T.uint64,
	StatusMessage: T.string,
	Duration: T.uint64,
	ErrorLabel: T.string,
})

export const MetricsSum = table("metrics_sum", {
	OrgId: T.string,
	ResourceAttributes: T.map(T.string, T.string),
	ServiceName: T.string,
	MetricName: T.string,
	MetricDescription: T.string,
	MetricUnit: T.string,
	Attributes: T.map(T.string, T.string),
	StartTimeUnix: T.dateTime64,
	TimeUnix: T.dateTime64,
	Value: T.float64,
	Flags: T.uint32,
	AggregationTemporality: T.int32,
	IsMonotonic: T.bool,
})

export const MetricsGauge = table("metrics_gauge", {
	OrgId: T.string,
	ResourceAttributes: T.map(T.string, T.string),
	ServiceName: T.string,
	MetricName: T.string,
	MetricDescription: T.string,
	MetricUnit: T.string,
	Attributes: T.map(T.string, T.string),
	StartTimeUnix: T.dateTime64,
	TimeUnix: T.dateTime64,
	Value: T.float64,
	Flags: T.uint32,
})

export const MetricsHistogram = table("metrics_histogram", {
	OrgId: T.string,
	ResourceAttributes: T.map(T.string, T.string),
	ServiceName: T.string,
	MetricName: T.string,
	MetricDescription: T.string,
	MetricUnit: T.string,
	Attributes: T.map(T.string, T.string),
	StartTimeUnix: T.dateTime64,
	TimeUnix: T.dateTime64,
	Count: T.uint64,
	Sum: T.float64,
	BucketCounts: T.array(T.uint64),
	ExplicitBounds: T.array(T.float64),
	Flags: T.uint32,
	Min: T.nullable(T.float64),
	Max: T.nullable(T.float64),
	AggregationTemporality: T.int32,
})

export const MetricCatalog = table("metric_catalog", {
	OrgId: T.string,
	Hour: T.dateTime,
	MetricType: T.string,
	ServiceName: T.string,
	MetricName: T.string,
	MetricDescription: T.string,
	MetricUnit: T.string,
	IsMonotonic: T.uint8,
	DataPointCount: T.uint64,
	FirstSeen: T.dateTime,
	LastSeen: T.dateTime,
})

export const SpanMetricsCallsHourly = table("span_metrics_calls_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	ServiceName: T.string,
	MetricName: T.string,
	SpanKind: T.string,
	AttrFingerprint: T.uint64,
	ResourceFingerprint: T.uint64,
	StartTimeUnix: T.dateTime64,
	// The aggregate state column is typed by its finalized scalar value.
	LastValue: T.float64,
})

export const AttributeKeysHourly = table("attribute_keys_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	AttributeKey: T.string,
	AttributeScope: T.string,
	UsageCount: T.uint64,
})

export const AttributeValuesHourly = table("attribute_values_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	AttributeKey: T.string,
	AttributeValue: T.string,
	AttributeScope: T.string,
	UsageCount: T.uint64,
})

export const ServiceUsage = table("service_usage", {
	OrgId: T.string,
	ServiceName: T.string,
	Hour: T.dateTime,
	LogCount: T.uint64,
	LogSizeBytes: T.uint64,
	TraceCount: T.uint64,
	TraceSizeBytes: T.uint64,
	SumMetricCount: T.uint64,
	SumMetricSizeBytes: T.uint64,
	GaugeMetricCount: T.uint64,
	GaugeMetricSizeBytes: T.uint64,
	HistogramMetricCount: T.uint64,
	HistogramMetricSizeBytes: T.uint64,
	ExpHistogramMetricCount: T.uint64,
	ExpHistogramMetricSizeBytes: T.uint64,
})

export const ServiceMapSpans = table("service_map_spans", {
	OrgId: T.string,
	Timestamp: T.dateTime,
	TraceId: T.string,
	SpanId: T.string,
	ParentSpanId: T.string,
	ServiceName: T.string,
	SpanKind: T.string,
	Duration: T.uint64,
	StatusCode: T.string,
	TraceState: T.string,
	DeploymentEnv: T.string,
})

export const ServiceMapChildren = table("service_map_children", {
	OrgId: T.string,
	Timestamp: T.dateTime,
	TraceId: T.string,
	ParentSpanId: T.string,
	ServiceName: T.string,
	SpanKind: T.string,
	Duration: T.uint64,
	StatusCode: T.string,
	TraceState: T.string,
	DeploymentEnv: T.string,
})

export const TracesAggregatesHourly = table("traces_aggregates_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	ServiceName: T.string,
	SpanName: T.string,
	SpanKind: T.string,
	StatusCode: T.string,
	IsEntryPoint: T.uint8,
	DeploymentEnv: T.string,
	// The aggregate state columns are typed by their underlying scalar.
	// SELECT-side queries finalize them via -Merge combinators built in raw CH expressions.
	WeightedCount: T.float64,
	WeightedDurationSum: T.float64,
	WeightedErrorCount: T.float64,
	DurationQuantiles: T.uint64,
	DurationMin: T.uint64,
	DurationMax: T.uint64,
})

export const LogsAggregatesHourly = table("logs_aggregates_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	ServiceName: T.string,
	SeverityText: T.string,
	DeploymentEnv: T.string,
	ServiceNamespace: T.string,
	Count: T.uint64,
	SizeBytes: T.uint64,
})

export const ServiceMapEdgesHourly = table("service_map_edges_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	SourceService: T.string,
	TargetService: T.string,
	DeploymentEnv: T.string,
	CallCount: T.uint64,
	ErrorCount: T.uint64,
	DurationSumMs: T.float64,
	MaxDurationMs: T.float64,
	SampledSpanCount: T.uint64,
	UnsampledSpanCount: T.uint64,
	SampleRateSum: T.float64,
})

export const ServiceMapDbEdgesHourly = table("service_map_db_edges_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	ServiceName: T.string,
	DbSystem: T.string,
	DbNamespace: T.string,
	DeploymentEnv: T.string,
	CallCount: T.uint64,
	ErrorCount: T.uint64,
	DurationSumMs: T.float64,
	MaxDurationMs: T.float64,
	SampledSpanCount: T.uint64,
	UnsampledSpanCount: T.uint64,
	SampleRateSum: T.float64,
})

export const ServiceMapDbQueryShapesHourly = table("service_map_db_query_shapes_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	ServiceName: T.string,
	DbSystem: T.string,
	DbNamespace: T.string,
	DeploymentEnv: T.string,
	QueryKey: T.string,
	QueryLabel: T.string,
	SampleStatement: T.string,
	CallCount: T.uint64,
	ErrorCount: T.uint64,
	EstimatedCount: T.float64,
	EstimatedErrorCount: T.float64,
	WeightedDurationSumMs: T.float64,
	// AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32) —
	// opaque state, only ever touched via raw `...MergeState`/`...Merge` exprs.
	DurationQuantiles: T.string,
})

export const ServicePlatformsHourly = table("service_platforms_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	ServiceName: T.string,
	DeploymentEnv: T.string,
	K8sCluster: T.string,
	K8sPodName: T.string,
	K8sDeploymentName: T.string,
	K8sStatefulSetName: T.string,
	K8sDaemonSetName: T.string,
	K8sNamespaceName: T.string,
	CloudPlatform: T.string,
	CloudProvider: T.string,
	FaasName: T.string,
	MapleSdkType: T.string,
	ProcessRuntimeName: T.string,
	SpanCount: T.uint64,
})

export const AlertChecks = table("alert_checks", {
	OrgId: T.string,
	RuleId: T.string,
	GroupKey: T.string,
	Timestamp: T.dateTime64,
	Status: T.string,
	SignalType: T.string,
	Comparator: T.string,
	Threshold: T.float64,
	ObservedValue: T.nullable(T.float64),
	SampleCount: T.uint32,
	WindowMinutes: T.uint16,
	WindowStart: T.dateTime64,
	WindowEnd: T.dateTime64,
	ConsecutiveBreaches: T.uint16,
	ConsecutiveHealthy: T.uint16,
	IncidentId: T.nullable(T.string),
	IncidentTransition: T.string,
	EvaluationDurationMs: T.uint32,
	ErrorMessage: T.nullable(T.string),
	ErrorCategory: T.string,
})

export const SessionReplays = table("session_replays", {
	OrgId: T.string,
	SessionId: T.string,
	StartTime: T.dateTime64,
	EndTime: T.nullable(T.dateTime64),
	DurationMs: T.nullable(T.uint32),
	Status: T.string,
	UserId: T.string,
	UrlInitial: T.string,
	UserAgent: T.string,
	BrowserName: T.string,
	OsName: T.string,
	DeviceType: T.string,
	Country: T.string,
	ServiceName: T.string,
	PageViews: T.uint32,
	ClickCount: T.uint32,
	ErrorCount: T.uint32,
	TraceIds: T.array(T.string),
	ResourceAttributes: T.map(T.string, T.string),
	Version: T.uint32,
})

export const SessionReplayEvents = table("session_replay_events", {
	OrgId: T.string,
	SessionId: T.string,
	ChunkSeq: T.uint32,
	Timestamp: T.dateTime64,
	DurationMs: T.uint32,
	EventCount: T.uint32,
	ByteSize: T.uint32,
	// The rrweb event array for this chunk, stored as a JSON string. ClickHouse
	// ZSTD-compresses this column; playback reads it back directly (no R2).
	Events: T.string,
	IsCheckpoint: T.uint8,
})

// Distilled, structured semantic events for a session (navigation, clicks,
// console logs, network requests, errors), captured client-side by the SDK.
// Small and queryable — powers in-session search, the console/network/error
// panels, and the agent transcript. Sparse: only the fields relevant to a row's
// Type are populated; the rest default empty.
export const SessionEvents = table("session_events", {
	OrgId: T.string,
	SessionId: T.string,
	Timestamp: T.dateTime64,
	// Monotonic per-session ordering tiebreaker (events can share a ms timestamp).
	Seq: T.uint32,
	// "navigation" | "click" | "input" | "console" | "network" | "error"
	Type: T.string,
	Url: T.string,
	// OTel trace id active when the event fired (links network/error → traces).
	TraceId: T.string,
	// console / error: level + message.
	Level: T.string,
	Message: T.string,
	// click / input: the interaction target.
	TargetSelector: T.string,
	TargetText: T.string,
	// network: request summary.
	NetMethod: T.string,
	NetUrl: T.string,
	NetStatus: T.uint16,
	NetDurationMs: T.uint32,
	// error: stack trace.
	ErrorStack: T.string,
	// Overflow / extensibility.
	Attributes: T.map(T.string, T.string),
})

export const MetricsExpHistogram = table("metrics_exponential_histogram", {
	OrgId: T.string,
	ResourceAttributes: T.map(T.string, T.string),
	ServiceName: T.string,
	MetricName: T.string,
	MetricDescription: T.string,
	MetricUnit: T.string,
	Attributes: T.map(T.string, T.string),
	StartTimeUnix: T.dateTime64,
	TimeUnix: T.dateTime64,
	Count: T.uint64,
	Sum: T.float64,
	Scale: T.int32,
	ZeroCount: T.uint64,
	Flags: T.uint32,
	Min: T.nullable(T.float64),
	Max: T.nullable(T.float64),
	AggregationTemporality: T.int32,
})
