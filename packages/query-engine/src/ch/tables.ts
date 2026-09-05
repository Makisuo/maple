// Maple Table Definitions
//
// Derived from packages/domain/src/tinybird/datasources.ts
// These define the ClickHouse table schemas used by the query DSL.

import { type ColumnDefs, type Table, table as chTable } from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"
import { OrgId, SpanId, TraceId } from "@maple/domain"

/**
 * Maple's warehouse timestamps stay the strings ClickHouse sends.
 *
 * The builder's `T.dateTime` decodes to a `DateTime.Utc`, which is the better
 * value to compute with — but these rows are forwarded onto Maple's own HTTP
 * wire, where every timestamp is the `YYYY-MM-DD hh:mm:ss` string that web and
 * the iOS app already parse. Re-serializing them as ISO would be a silent
 * client-visible change, so the string flavour is declared here and a migration
 * to `DateTime.Utc` can happen per surface.
 */
const dateTime = T.dateTimeString
const dateTime64 = T.dateTime64String

/**
 * The type every attribute column in the warehouse has.
 *
 * Named so helpers that work across tables — anything taking "a table with a
 * `SpanAttributes` column" — can say so structurally without falling back to
 * `ColumnRef<"SpanAttributes", any>`. An `any` there erases the map's value
 * type, and `$.SpanAttributes.get(k)` then decodes as `unknown`, which costs
 * the query its derived row schema.
 */
export type StringMap = T.CHMap<T.CHString, T.CHString>

/**
 * Identity columns carry their branded domain schemas, so a query that SELECTs
 * one derives a row schema whose decoded type is the brand — no declared
 * `rowSchema` needed just to keep `OrgId`/`TraceId`/`SpanId` in the output
 * type. Comparisons still take plain strings/params: the builder widens a
 * branded column's comparison type to its primitive.
 */
const orgId = T.custom("String", OrgId)
const traceId = T.custom("String", TraceId)
const spanId = T.custom("String", SpanId)

/**
 * Every Maple warehouse table is keyed by `OrgId`, so tenancy is declared once
 * here rather than at 37 call sites. Requiring the column in the signature is
 * the point: a new table without one is a type error, not a table that silently
 * compiles every query as `cross-tenant`.
 */
const table = <const Name extends string, const Columns extends ColumnDefs & { OrgId: T.CHStringLike }>(
	name: Name,
	columns: Columns,
): Table<Name, Columns> => chTable(name, columns, { tenantColumn: "OrgId" })

export const Traces = table("traces", {
	OrgId: orgId,
	Timestamp: dateTime64,
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
	EventsTimestamp: T.array(dateTime64),
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
	OrgId: orgId,
	Timestamp: dateTime64,
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
})

/**
 * Filtered projection of GenAI agent spans (`maple_ai.vendor.id` stamped),
 * pre-extracted to plain columns — the Agent Sessions detection/facet surface.
 * `SessionId` is `''` on most rows: vendors stamp the session key only on the
 * turn-owning spans, so session resolution stays per-trace at read time.
 *
 * Migration 0026 added the sidebar's other facet dimensions (`DeploymentEnv`,
 * `Model`, `AgentName`, `ToolName`) and the per-span measures the page ranks
 * and filters on (`IsError`, `IsLlmCall`, `IsToolCall`, `Tokens`, `Cost`, with
 * `SpanId`/`ParentSpanId`/`Duration`), all coalesced and classified at insert
 * by `@maple/domain/tinybird/gen-ai-columns`; `''`/0 where the span carries no
 * such fact, and on every row materialized before 0026.
 */
export const AiTraceIndex = table("ai_trace_index", {
	OrgId: orgId,
	Timestamp: dateTime64,
	TraceId: T.string,
	SessionId: T.string,
	VendorId: T.string,
	ServiceName: T.string,
	DeploymentEnv: T.string,
	Model: T.string,
	AgentName: T.string,
	ToolName: T.string,
	SpanId: T.string,
	ParentSpanId: T.string,
	Duration: T.uint64,
	IsError: T.uint8,
	IsLlmCall: T.uint8,
	IsToolCall: T.uint8,
	Tokens: T.float64,
	Cost: T.float64,
})

export const TraceListMv = table("trace_list_mv", {
	OrgId: orgId,
	TraceId: T.string,
	Timestamp: dateTime,
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
	OrgId: orgId,
	Timestamp: dateTime64,
	TimestampTime: dateTime,
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
	OrgId: orgId,
	Timestamp: dateTime,
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
	OrgId: orgId,
	Hour: dateTime,
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
	FirstSeen: dateTime,
	ApdexSatisfiedCount: T.uint64,
	ApdexToleratingCount: T.uint64,
})

/**
 * Minute-grain twin of {@link ServiceOverviewHourly}, for windows whose bucket
 * size is under an hour. Columns are deliberately identical apart from the
 * bucket column, so the two can share a UNION ALL branch shape.
 */
export const ServiceOverviewMinutely = table("service_overview_minutely", {
	OrgId: orgId,
	Minute: dateTime,
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
	FirstSeen: dateTime,
	ApdexSatisfiedCount: T.uint64,
	ApdexToleratingCount: T.uint64,
})

export const ErrorEvents = table("error_events", {
	OrgId: orgId,
	Timestamp: dateTime,
	TraceId: traceId,
	SpanId: spanId,
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
	OrgId: orgId,
	Timestamp: dateTime,
	TraceId: traceId,
	SpanId: spanId,
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
	OrgId: orgId,
	Minute: dateTime,
	FingerprintHash: T.uint64,
	ServiceName: T.string,
	ExceptionType: T.string,
	ExceptionMessage: T.string,
	ErrorLabel: T.string,
	TopFrame: T.string,
	OccurrenceCount: T.uint64,
	FirstSeen: dateTime,
	LastSeen: dateTime,
	ServiceVersions: T.array(T.string),
})

export const MetricsSum = table("metrics_sum", {
	OrgId: orgId,
	ResourceAttributes: T.map(T.string, T.string),
	ServiceName: T.string,
	MetricName: T.string,
	MetricDescription: T.string,
	MetricUnit: T.string,
	Attributes: T.map(T.string, T.string),
	StartTimeUnix: dateTime64,
	TimeUnix: dateTime64,
	Value: T.float64,
	Flags: T.uint32,
	AggregationTemporality: T.int32,
	IsMonotonic: T.bool,
})

export const MetricsGauge = table("metrics_gauge", {
	OrgId: orgId,
	ResourceAttributes: T.map(T.string, T.string),
	ServiceName: T.string,
	MetricName: T.string,
	MetricDescription: T.string,
	MetricUnit: T.string,
	Attributes: T.map(T.string, T.string),
	StartTimeUnix: dateTime64,
	TimeUnix: dateTime64,
	Value: T.float64,
	Flags: T.uint32,
})

export const MetricsHistogram = table("metrics_histogram", {
	OrgId: orgId,
	ResourceAttributes: T.map(T.string, T.string),
	ServiceName: T.string,
	MetricName: T.string,
	MetricDescription: T.string,
	MetricUnit: T.string,
	Attributes: T.map(T.string, T.string),
	StartTimeUnix: dateTime64,
	TimeUnix: dateTime64,
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
	OrgId: orgId,
	Hour: dateTime,
	MetricType: T.string,
	ServiceName: T.string,
	MetricName: T.string,
	MetricDescription: T.string,
	MetricUnit: T.string,
	IsMonotonic: T.uint8,
	DataPointCount: T.uint64,
	FirstSeen: dateTime,
	LastSeen: dateTime,
})

export const SpanMetricsCallsHourly = table("span_metrics_calls_hourly", {
	OrgId: orgId,
	Hour: dateTime,
	ServiceName: T.string,
	MetricName: T.string,
	SpanKind: T.string,
	AttrFingerprint: T.uint64,
	ResourceFingerprint: T.uint64,
	StartTimeUnix: dateTime64,
	// The aggregate state column is typed by its finalized scalar value.
	LastValue: T.float64,
})

export const AttributeKeysHourly = table("attribute_keys_hourly", {
	OrgId: orgId,
	Hour: dateTime,
	AttributeKey: T.string,
	AttributeScope: T.string,
	UsageCount: T.uint64,
})

export const AttributeValuesHourly = table("attribute_values_hourly", {
	OrgId: orgId,
	Hour: dateTime,
	AttributeKey: T.string,
	AttributeValue: T.string,
	AttributeScope: T.string,
	UsageCount: T.uint64,
})

export const ServiceUsage = table("service_usage", {
	OrgId: orgId,
	ServiceName: T.string,
	Hour: dateTime,
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
	OrgId: orgId,
	Timestamp: dateTime,
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
	OrgId: orgId,
	Timestamp: dateTime,
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
	OrgId: orgId,
	Hour: dateTime,
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
	OrgId: orgId,
	Minute: dateTime,
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
	// Added by migration 0023; 0 across all three means the bucket predates it.
	ClassifiedSpanCount: T.uint64,
	ServerSpanCount: T.uint64,
	RoutedSpanCount: T.uint64,
})

export const LogsAggregatesHourly = table("logs_aggregates_hourly", {
	OrgId: orgId,
	Hour: dateTime,
	ServiceName: T.string,
	SeverityText: T.string,
	DeploymentEnv: T.string,
	ServiceNamespace: T.string,
	Count: T.uint64,
	SizeBytes: T.uint64,
})

export const ServiceMapEdgesHourly = table("service_map_edges_hourly", {
	OrgId: orgId,
	Hour: dateTime,
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
	OrgId: orgId,
	Hour: dateTime,
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
	OrgId: orgId,
	Hour: dateTime,
	SourceService: T.string,
	ParentServerAddress: T.string,
	ResolvedTargetService: T.string,
	DeploymentEnv: T.string,
})

export const ServiceMapDbEdgesHourly = table("service_map_db_edges_hourly", {
	OrgId: orgId,
	Hour: dateTime,
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
	OrgId: orgId,
	Hour: dateTime,
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
	OrgId: orgId,
	Hour: dateTime,
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
	OrgId: orgId,
	Hour: dateTime,
	ServiceName: T.string,
	DeploymentEnv: T.string,
	SpanName: T.string,
	SpanCount: T.uint64,
	EstimatedSpanCount: T.float64,
	ErrorCount: T.uint64,
	EstimatedErrorCount: T.float64,
	DurationSum: T.float64,
	DurationQuantiles: T.string,
	// Added by migration 0023; 0 across all three means the bucket predates it.
	ClassifiedSpanCount: T.uint64,
	ServerSpanCount: T.uint64,
	RoutedSpanCount: T.uint64,
})

export const AlertChecks = table("alert_checks", {
	OrgId: orgId,
	RuleId: T.string,
	GroupKey: T.string,
	Timestamp: dateTime64,
	Status: T.string,
	SignalType: T.string,
	Comparator: T.string,
	Threshold: T.float64,
	ObservedValue: T.nullable(T.float64),
	SampleCount: T.uint32,
	WindowMinutes: T.uint16,
	WindowStart: dateTime64,
	WindowEnd: dateTime64,
	ConsecutiveBreaches: T.uint16,
	ConsecutiveHealthy: T.uint16,
	IncidentId: T.nullable(T.string),
	IncidentTransition: T.string,
	EvaluationDurationMs: T.uint32,
	ErrorMessage: T.nullable(T.string),
	ErrorCategory: T.string,
})

export const AuditLog = table("audit_log", {
	OrgId: orgId,
	Id: T.string,
	OccurredAt: dateTime64,
	RecordedAt: dateTime64,
	ActorType: T.string,
	UserId: T.string,
	ApiKeyId: T.string,
	ActorId: T.string,
	ActorLabel: T.string,
	AffectedUserId: T.string,
	Source: T.string,
	Action: T.string,
	Outcome: T.string,
	DenialReason: T.string,
	ResourceType: T.string,
	ResourceId: T.string,
	ChangedFields: T.array(T.string),
	Changes: T.string,
	Metadata: T.string,
	RequestId: T.string,
	OriginIp: T.string,
	OriginCountry: T.string,
})

export const SessionReplays = table("session_replays", {
	OrgId: orgId,
	SessionId: T.string,
	StartTime: dateTime64,
	EndTime: T.nullable(dateTime64),
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
	LastActivityAt: T.nullable(dateTime64),
})

export const SessionReplayEvents = table("session_replay_events", {
	OrgId: orgId,
	SessionId: T.string,
	ChunkSeq: T.uint32,
	// Gateway receipt time — partitioning, TTL, and the anchor the chunk index
	// resolves a seek target against.
	Timestamp: dateTime64,
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
	OrgId: orgId,
	SessionId: T.string,
	Timestamp: dateTime64,
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
	// Identity stamped by the SDK per event ('' on builds that predate it).
	VisitorId: T.string,
	UserId: T.string,
	GroupId: T.string,
})

// Product events fact table — every event a funnel or product-analytics query
// can step on. Dual-fed: the navigation and custom rows of session_events arrive
// via `product_events_mv` (Source='browser'), backend and mobile events are
// posted directly through `POST /v1/events` (Source='server' | 'mobile').
//
// Exists because session_events is sorted (OrgId, SessionId, Timestamp, Seq), so
// a time-range filter there cannot use the primary index at all, and its idx_type
// skip index prunes ~nothing (navigation rows are interleaved through every
// session's transcript). Reads that only want page views were scanning ~13x the
// rows they used and parsing domain(Url)/path(Url) per row on top.
//
// The funnel substrate: windowFunnel over (Timestamp, EventName, PagePath)
// grouped by the person key `if(UserId != '', UserId, VisitorId)`, stitched
// through `identity_links`. VisitorId is third in the sorting key so one
// person's rows are contiguous inside a time range.
export const ProductEvents = table("product_events", {
	OrgId: orgId,
	Timestamp: dateTime64,
	// "browser" | "server" | "mobile".
	Source: T.string,
	// '' on server rows.
	SessionId: T.string,
	// Tiebreaker within a millisecond, so a funnel's step order is stable. 0 on
	// direct rows.
	Seq: T.uint32,
	VisitorId: T.string,
	UserId: T.string,
	GroupId: T.string,
	// "navigation" | "custom" | "screen" — the source type, carried through
	// unchanged. This is the page-view predicate, NOT `EventName = '$pageview'`:
	// track() takes a caller-supplied name with no reserved-prefix check on the
	// browser path, so a customer calling track('$pageview') would otherwise
	// inflate the count.
	Kind: T.string,
	// "$pageview" for navigation, "$screen" for mobile screens, else the track()
	// name. The funnel step key.
	EventName: T.string,
	// domain(Url) / path(Url), materialized at write time.
	Host: T.string,
	PagePath: T.string,
	Url: T.string,
	// The emitting service on direct rows; '' on browser rows.
	ServiceName: T.string,
	// track() props.
	Attributes: T.map(T.string, T.string),
	// The trace this event was derived from — non-empty only on Source='trace'
	// rows, i.e. spans the customer annotated with `maple.product_event.name`.
	// The link in both directions: trace view → its product events, funnel row →
	// the trace that performed the step.
	TraceId: T.string,
	// The annotated span within TraceId. '' on every other source.
	SpanId: T.string,
})

// (VisitorId, UserId) pairs observed together on a session_replays row.
// AggregatingMergeTree keyed on the pair, `FirstSeen` collapsing under `min` —
// so a merge keeps the pair's EARLIEST sighting rather than an arbitrary one,
// which is what makes ranking a visitor's users by it stable. Unmerged parts
// still hold several rows per pair, so always aggregate (`min(FirstSeen)` per
// pair) or semi-join; never assume one row per pair on read.
export const IdentityLinks = table("identity_links", {
	OrgId: orgId,
	VisitorId: T.string,
	UserId: T.string,
	FirstSeen: dateTime64,
})
export const MetricsExpHistogram = table("metrics_exponential_histogram", {
	OrgId: orgId,
	ResourceAttributes: T.map(T.string, T.string),
	ServiceName: T.string,
	MetricName: T.string,
	MetricDescription: T.string,
	MetricUnit: T.string,
	Attributes: T.map(T.string, T.string),
	StartTimeUnix: dateTime64,
	TimeUnix: dateTime64,
	Count: T.uint64,
	Sum: T.float64,
	Scale: T.int32,
	ZeroCount: T.uint64,
	Flags: T.uint32,
	Min: T.nullable(T.float64),
	Max: T.nullable(T.float64),
	AggregationTemporality: T.int32,
})
