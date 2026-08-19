// Maple Table Definitions
//
// Derived from packages/domain/src/tinybird/datasources.ts
// These define the ClickHouse table schemas used by the query DSL.

import { table } from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"

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
	ResourceAttributeItems: T.array(T.string),
	ScopeAttributeItems: T.array(T.string),
	SpanAttributeItems: T.array(T.string),
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
	ResourceAttributeItems: T.array(T.string),
	ScopeAttributeItems: T.array(T.string),
	LogAttributeItems: T.array(T.string),
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

export const ServiceOverviewHourly = table("service_overview_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	ServiceName: T.string,
	DeploymentEnv: T.string,
	ServiceNamespace: T.string,
	CommitSha: T.string,
	SpanCount: T.uint64,
	EstimatedSpanCount: T.float64,
	ErrorCount: T.uint64,
	EstimatedErrorCount: T.float64,
	DurationSum: T.float64,
	DurationQuantiles: T.string,
	FirstSeen: T.dateTime,
	ApdexSatisfiedCount: T.uint64,
	ApdexToleratingCount: T.uint64,
})

/**
 * Minute-grain twin of {@link ServiceOverviewHourly}, for windows whose bucket
 * size is under an hour. Columns are deliberately identical apart from the
 * bucket column, so the two can share a UNION ALL branch shape.
 */
export const ServiceOverviewMinutely = table("service_overview_minutely", {
	OrgId: T.string,
	Minute: T.dateTime,
	ServiceName: T.string,
	DeploymentEnv: T.string,
	ServiceNamespace: T.string,
	CommitSha: T.string,
	SpanCount: T.uint64,
	EstimatedSpanCount: T.float64,
	ErrorCount: T.uint64,
	EstimatedErrorCount: T.float64,
	DurationSum: T.float64,
	DurationQuantiles: T.string,
	FirstSeen: T.dateTime,
	ApdexSatisfiedCount: T.uint64,
	ApdexToleratingCount: T.uint64,
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
	ServiceVersion: T.string,
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
	ServiceVersion: T.string,
})

/** Minute-grain per-fingerprint rollup consumed by the error issue tick. */
export const ErrorFingerprintsMinutely = table("error_fingerprints_minutely", {
	OrgId: T.string,
	Minute: T.dateTime,
	FingerprintHash: T.uint64,
	ServiceName: T.string,
	ExceptionType: T.string,
	ExceptionMessage: T.string,
	ErrorLabel: T.string,
	TopFrame: T.string,
	OccurrenceCount: T.uint64,
	FirstSeen: T.dateTime,
	LastSeen: T.dateTime,
	ServiceVersion: T.string,
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

export const ServiceOperationsMinutely = table("service_operations_minutely", {
	OrgId: T.string,
	Minute: T.dateTime,
	ServiceName: T.string,
	DeploymentEnv: T.string,
	SpanName: T.string,
	SpanCount: T.uint64,
	EstimatedSpanCount: T.float64,
	ErrorCount: T.uint64,
	EstimatedErrorCount: T.float64,
	DurationSum: T.float64,
	// AggregateFunction(quantilesTDigest(0.5, 0.95), UInt64) — opaque state.
	DurationQuantiles: T.string,
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

// Reached only from the raw-SQL builders in queries/service-map.ts, which
// interpolate `.name` rather than going through the DSL — the `multiIf` ladders
// they emit are what the DSL can't express. Declared here anyway so
// tables.test.ts drift-checks the columns those builders read.
export const ServiceExternalEdgesHourly = table("service_external_edges_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	ServiceName: T.string,
	TargetType: T.string,
	TargetSystem: T.string,
	TargetName: T.string,
	DeploymentEnv: T.string,
	CallCount: T.uint64,
	ErrorCount: T.uint64,
	DurationSumMs: T.float64,
	MaxDurationMs: T.float64,
	SampleRateSum: T.float64,
})

export const ServiceAddressResolutionsHourly = table("service_address_resolutions_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	SourceService: T.string,
	ParentServerAddress: T.string,
	ResolvedTargetService: T.string,
	DeploymentEnv: T.string,
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

export const ServiceMapDbQuerySignaturesHourly = table("service_map_db_query_shapes_hourly", {
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

export const ServiceOperationsHourly = table("service_operations_hourly", {
	OrgId: T.string,
	Hour: T.dateTime,
	ServiceName: T.string,
	DeploymentEnv: T.string,
	SpanName: T.string,
	SpanCount: T.uint64,
	EstimatedSpanCount: T.float64,
	ErrorCount: T.uint64,
	EstimatedErrorCount: T.float64,
	DurationSum: T.float64,
	DurationQuantiles: T.string,
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
	// Analytics dimensions (migration 0011). Hand-mirrored from
	// packages/domain/src/tinybird/datasources.ts; `tables.test.ts` asserts the
	// mirror against the generated warehouse DDL, so drift fails the build instead
	// of surfacing as a runtime "unknown column".
	//
	// Persistent per-browser id: uniq(VisitorId) = unique visitors. VisitorIsNew
	// is client-asserted because a self-join against earlier sessions is both a
	// second full scan and wrong past the 30-day TTL.
	VisitorId: T.string,
	VisitorIsNew: T.uint8,
	UserEmail: T.string,
	UserName: T.string,
	GroupId: T.string,
	GroupName: T.string,
	// Trait keys are arbitrary customer-defined dimensions, so the warehouse map
	// deliberately uses plain String keys rather than a shared LC dictionary.
	UserTraits: T.map(T.string, T.string),
	Referrer: T.string,
	// Gateway-normalized (lowercased, `www.` stripped). '' = direct, internal, or
	// suppressed by Referrer-Policy — not the same thing as "direct traffic".
	ReferrerHost: T.string,
	UtmSource: T.string,
	UtmMedium: T.string,
	UtmCampaign: T.string,
	UtmTerm: T.string,
	UtmContent: T.string,
	Host: T.string,
	// Pathname only, no query string or hash. Note UrlInitial above is a misnomer
	// — the SDK sets it from location.href at post time, so it tracks the latest
	// URL; EntryPath is the real entry page.
	EntryPath: T.string,
	ExitPath: T.string,
	Language: T.string,
	// Heartbeat-refreshed. Recovers duration for sessions killed without an
	// unload beacon, where EndTime is null.
	LastActivityAt: T.nullable(T.dateTime64),
})

export const SessionReplayEvents = table("session_replay_events", {
	OrgId: T.string,
	SessionId: T.string,
	ChunkSeq: T.uint32,
	// Gateway receipt time — partitioning, TTL, and the anchor the chunk index
	// resolves a seek target against.
	Timestamp: T.dateTime64,
	DurationMs: T.uint32,
	EventCount: T.uint32,
	ByteSize: T.uint32,
	// The rrweb event array for this chunk as a JSON string — inline for
	// pre-cutover rows and blob-store-less deployments, empty when the payload
	// lives in R2 (the API refills it on read).
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
	// "navigation" | "click" | "input" | "console" | "network" | "error" | "custom"
	// "custom" rows come from the SDK's track(name, props): Message = event name,
	// Attributes = props. The gateway enforces this allowlist.
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

// Web analytics fact table — the navigation and custom rows of session_events,
// re-sorted by time with the URL pre-parsed. Populated by `web_events_mv`.
//
// Exists because session_events is sorted (OrgId, SessionId, Timestamp, Seq), so
// a time-range filter there cannot use the primary index at all, and its idx_type
// skip index prunes ~nothing (navigation rows are interleaved through every
// session's transcript). Reads that only want page views were scanning ~13x the
// rows they used and parsing domain(Url)/path(Url) per row on top.
//
// Also the funnel substrate: windowFunnel over (Timestamp, EventName, PagePath)
// grouped by SessionId.
export const WebEvents = table("web_events", {
	OrgId: T.string,
	Timestamp: T.dateTime64,
	SessionId: T.string,
	// Tiebreaker within a millisecond, so a funnel's step order is stable.
	Seq: T.uint32,
	// "navigation" | "custom" — the source Type, carried through unchanged. This
	// is the page-view predicate, NOT `EventName = '$pageview'`: track() takes a
	// caller-supplied name with no reserved-prefix check, so a customer calling
	// track('$pageview') would otherwise inflate the count.
	Kind: T.string,
	// "$pageview" for navigation, else the track() name. The funnel step key.
	EventName: T.string,
	// domain(Url) / path(Url), materialized at write time.
	Host: T.string,
	PagePath: T.string,
	Url: T.string,
	// track() props.
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
