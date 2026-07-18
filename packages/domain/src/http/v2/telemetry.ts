import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { MetricName, ServiceName, SpanId, TraceId } from "../../primitives"
import { AuthorizationV2, V2SchemaErrors } from "./auth"
import { ListOf, ListQuery, Timestamp } from "./envelopes"
import { V2InvalidRequestError, V2NotFoundError, V2ServiceUnavailableError } from "./errors"
import { PublicId, PublicIdPrefixes } from "./public-id"

const wireExample = <A>(example: object): A => example as A
const commonErrors = [V2InvalidRequestError, V2ServiceUnavailableError] as const
const PositiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const PositiveFinite = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))
const NonNegativeFinite = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
const BreakdownLimit = PositiveInteger.check(Schema.isLessThanOrEqualTo(100))
const TimeseriesSeriesLimit = PositiveInteger.check(Schema.isLessThanOrEqualTo(100))

export const LogPublicId = PublicId(PublicIdPrefixes.log, Schema.String).annotate({
	identifier: "LogId",
	title: "Log ID",
})

const JsonStringRecord = Schema.Record(Schema.String, Schema.String)
const RequiredTimeRange = {
	start_time: Timestamp.annotate({
		description: "Inclusive query-window start.",
	}),
	end_time: Timestamp.annotate({ description: "Inclusive query-window end." }),
} as const
const PostPagination = {
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
	),
	cursor: Schema.optionalKey(Schema.String),
} as const

export const V2TelemetryWindowQuery = Schema.Struct({
	...RequiredTimeRange,
}).annotate({
	identifier: "TelemetryWindowQuery",
	title: "Telemetry time window",
})

export const V2TraceSummary = Schema.Struct({
	id: TraceId,
	object: Schema.Literal("trace"),
	start_time: Timestamp,
	duration_ms: Schema.Number,
	root_span_name: Schema.String,
	root_span_kind: Schema.String,
	root_service_name: Schema.String,
	status_code: Schema.String,
	has_error: Schema.Boolean,
	deployment_environment: Schema.NullOr(Schema.String),
	service_namespace: Schema.NullOr(Schema.String),
	http_method: Schema.NullOr(Schema.String),
	http_route: Schema.NullOr(Schema.String),
	http_status_code: Schema.NullOr(Schema.String),
}).annotate({
	identifier: "TraceSummary",
	title: "Trace summary",
	description: "A root-based summary returned by trace search.",
	examples: [
		wireExample({
			id: "7f3a4b5c6d7e8f901234567890abcdef",
			object: "trace",
			start_time: "2026-07-15T12:00:00.000Z",
			duration_ms: 42.5,
			root_span_name: "GET /checkout",
			root_span_kind: "Server",
			root_service_name: "api",
			status_code: "Ok",
			has_error: false,
			deployment_environment: "production",
			service_namespace: "checkout",
			http_method: "GET",
			http_route: "/checkout",
			http_status_code: "200",
		}),
	],
})
export type V2TraceSummary = Schema.Schema.Type<typeof V2TraceSummary>

export const V2Span = Schema.Struct({
	id: SpanId,
	object: Schema.Literal("span"),
	trace_id: TraceId,
	parent_span_id: Schema.NullOr(SpanId),
	name: Schema.String,
	service_name: Schema.String,
	kind: Schema.String,
	start_time: Timestamp,
	duration_ms: Schema.Number,
	status_code: Schema.String,
	status_message: Schema.NullOr(Schema.String),
	attributes: JsonStringRecord,
	resource_attributes: JsonStringRecord,
}).annotate({
	identifier: "Span",
	title: "Span",
	description: "An OpenTelemetry span.",
})
export type V2Span = Schema.Schema.Type<typeof V2Span>

export const V2Trace = Schema.Struct({
	id: TraceId,
	object: Schema.Literal("trace"),
	start_time: Timestamp,
	end_time: Timestamp,
	duration_ms: Schema.Number,
	span_count: Schema.Number,
	service_count: Schema.Number,
	truncated: Schema.Boolean,
	spans: Schema.Array(V2Span),
}).annotate({
	identifier: "Trace",
	title: "Trace",
	description: "A trace and its spans.",
})
export type V2Trace = Schema.Schema.Type<typeof V2Trace>

export const V2TraceSearchParams = Schema.Struct({
	...RequiredTimeRange,
	...PostPagination,
	service_name: Schema.optionalKey(ServiceName),
	span_name: Schema.optionalKey(Schema.String),
	has_error: Schema.optionalKey(Schema.Boolean),
	min_duration_ms: Schema.optionalKey(NonNegativeFinite),
	max_duration_ms: Schema.optionalKey(NonNegativeFinite),
	http_method: Schema.optionalKey(Schema.String),
	http_status_code: Schema.optionalKey(Schema.String),
	deployment_environment: Schema.optionalKey(Schema.String),
	service_namespace: Schema.optionalKey(Schema.String),
}).annotate({
	identifier: "TraceSearchParams",
	title: "Trace search parameters",
})

const TraceList = ListOf(V2TraceSummary).annotate({
	identifier: "TraceList",
	title: "Trace list",
})

export class V2TracesApiGroup extends HttpApiGroup.make("traces")
	.add(
		HttpApiEndpoint.post("search", "/search", {
			payload: V2TraceSearchParams,
			success: TraceList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "searchTraces",
				summary: "Search traces",
				description: "Searches root traces in an explicit time window. Requires `traces:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:trace_id", {
			params: { trace_id: TraceId },
			success: V2Trace,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getTrace",
				summary: "Retrieve a trace",
				description:
					"Returns a trace and its flat parent-linked span collection. Requires `traces:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieveSpan", "/:trace_id/spans/:span_id", {
			params: { trace_id: TraceId, span_id: SpanId },
			success: V2Span,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getSpan",
				summary: "Retrieve a span",
				description: "Returns one span with complete attribute maps. Requires `traces:read`.",
			}),
		),
	)
	.prefix("/v2/traces")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Traces",
			description: "Search and inspect distributed traces.",
		}),
	) {}

export const V2Log = Schema.Struct({
	id: LogPublicId,
	object: Schema.Literal("log"),
	timestamp: Timestamp,
	severity_text: Schema.String,
	severity_number: Schema.Number,
	service_name: Schema.String,
	body: Schema.String,
	trace_id: Schema.NullOr(TraceId),
	span_id: Schema.NullOr(SpanId),
	log_attributes: JsonStringRecord,
	resource_attributes: JsonStringRecord,
}).annotate({
	identifier: "Log",
	title: "Log",
	description: "An OpenTelemetry log record.",
})
export type V2Log = Schema.Schema.Type<typeof V2Log>

export const V2LogSearchParams = Schema.Struct({
	...RequiredTimeRange,
	...PostPagination,
	service_name: Schema.optionalKey(ServiceName),
	severity: Schema.optionalKey(Schema.String),
	min_severity: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 255 })),
	),
	trace_id: Schema.optionalKey(TraceId),
	span_id: Schema.optionalKey(SpanId),
	search: Schema.optionalKey(Schema.String),
	deployment_environment: Schema.optionalKey(Schema.String),
	service_namespace: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "LogSearchParams", title: "Log search parameters" })
const LogList = ListOf(V2Log).annotate({
	identifier: "LogList",
	title: "Log list",
})

export class V2LogsApiGroup extends HttpApiGroup.make("logs")
	.add(
		HttpApiEndpoint.post("search", "/search", {
			payload: V2LogSearchParams,
			success: LogList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "searchLogs",
				summary: "Search logs",
				description: "Searches logs in an explicit time window. Requires `logs:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:id", {
			params: { id: LogPublicId },
			success: V2Log,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getLog",
				summary: "Retrieve a log",
				description: "Returns a log by its opaque `log_…` ID. Requires `logs:read`.",
			}),
		),
	)
	.prefix("/v2/logs")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Logs",
			description: "Search and retrieve OpenTelemetry logs.",
		}),
	) {}

export const V2Metric = Schema.Struct({
	object: Schema.Literal("metric"),
	name: MetricName,
	type: Schema.String,
	service_name: Schema.String,
	description: Schema.String,
	unit: Schema.String,
	is_monotonic: Schema.Boolean,
	data_point_count: Schema.Number,
	first_seen: Timestamp,
	last_seen: Timestamp,
}).annotate({
	identifier: "Metric",
	title: "Metric",
	description: "A metric catalog entry.",
})
export type V2Metric = Schema.Schema.Type<typeof V2Metric>

export const V2MetricListQuery = Schema.Struct({
	...V2TelemetryWindowQuery.fields,
	...ListQuery.fields,
	service_name: Schema.optional(ServiceName),
	metric_type: Schema.optional(Schema.String),
	search: Schema.optional(Schema.String),
}).annotate({ identifier: "MetricListQuery", title: "Metric list query" })

export const V2AttributeFilter = Schema.Struct({
	key: Schema.String,
	value: Schema.optionalKey(Schema.String),
	mode: Schema.Literals(["equals", "exists", "gt", "gte", "lt", "lte", "contains"]),
	negated: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "AttributeFilter", title: "Attribute filter" })

const MetricsMetric = Schema.Literals(["avg", "sum", "min", "max", "count", "rate", "increase"])
const MetricType = Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"])
const MetricsFilters = {
	metric_name: MetricName,
	metric_type: MetricType,
	service_name: Schema.optionalKey(ServiceName),
	group_by_attribute_key: Schema.optionalKey(Schema.String),
	group_by_resource_attribute_key: Schema.optionalKey(Schema.String),
	attribute_filters: Schema.optionalKey(Schema.Array(V2AttributeFilter)),
	resource_attribute_filters: Schema.optionalKey(Schema.Array(V2AttributeFilter)),
} as const

export const V2MetricsTimeseriesParams = Schema.Struct({
	...RequiredTimeRange,
	metric: MetricsMetric,
	...MetricsFilters,
	group_by: Schema.optionalKey(
		Schema.Array(Schema.Literals(["service", "attribute", "resource_attribute", "none"])),
	),
	bucket_seconds: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
	series_limit: Schema.optionalKey(TimeseriesSeriesLimit),
}).annotate({
	identifier: "MetricsTimeseriesParams",
	title: "Metrics timeseries parameters",
})

export const V2TimeseriesPoint = Schema.Struct({
	bucket: Timestamp,
	series: Schema.Record(Schema.String, Schema.Number),
}).annotate({ identifier: "TimeseriesPoint", title: "Timeseries point" })
export const V2BreakdownItem = Schema.Struct({
	name: Schema.String,
	value: Schema.Number,
}).annotate({ identifier: "BreakdownItem", title: "Breakdown item" })
export const V2StructuredQueryResult = Schema.Struct({
	object: Schema.Literal("query_result"),
	kind: Schema.Literals(["timeseries", "breakdown"]),
	source: Schema.Literals(["traces", "logs", "metrics"]),
	timeseries: Schema.Array(V2TimeseriesPoint),
	breakdown: Schema.Array(V2BreakdownItem),
}).annotate({
	identifier: "StructuredQueryResult",
	title: "Structured query result",
})
export type V2StructuredQueryResult = Schema.Schema.Type<typeof V2StructuredQueryResult>

const MetricList = ListOf(V2Metric).annotate({
	identifier: "MetricList",
	title: "Metric list",
})
export class V2MetricsApiGroup extends HttpApiGroup.make("metrics")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: V2MetricListQuery,
			success: MetricList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listMetrics",
				summary: "List metrics",
				description:
					"Lists metric catalog entries in an explicit time window. Requires `metrics:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("timeseries", "/timeseries", {
			payload: V2MetricsTimeseriesParams,
			success: V2StructuredQueryResult,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "queryMetricsTimeseries",
				summary: "Query metric timeseries",
				description: "Executes one typed metric timeseries query. Requires `metrics:read`.",
			}),
		),
	)
	.prefix("/v2/metrics")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Metrics",
			description: "Browse and query OpenTelemetry metrics.",
		}),
	) {}

export const V2Service = Schema.Struct({
	object: Schema.Literal("service"),
	name: ServiceName,
	service_namespaces: Schema.Array(Schema.String),
	deployment_environments: Schema.Array(Schema.String),
	throughput: Schema.Number,
	traced_throughput: Schema.Number,
	span_count: Schema.Number,
	error_count: Schema.Number,
	error_rate: Schema.Number,
	p50_latency_ms: Schema.Number,
	p95_latency_ms: Schema.Number,
	p99_latency_ms: Schema.Number,
	has_sampling: Schema.Boolean,
	sampling_weight: Schema.Number,
}).annotate({
	identifier: "Service",
	title: "Service",
	description: "An observed service aggregated by service name.",
})
export type V2Service = Schema.Schema.Type<typeof V2Service>

export const V2ServiceListQuery = Schema.Struct({
	...V2TelemetryWindowQuery.fields,
	...ListQuery.fields,
	deployment_environment: Schema.optional(Schema.String),
	service_namespace: Schema.optional(Schema.String),
}).annotate({ identifier: "ServiceListQuery", title: "Service list query" })

export const V2ServiceMapEdge = Schema.Struct({
	object: Schema.Literal("service_map.edge"),
	source_service: Schema.String,
	target_service: Schema.String,
	call_count: Schema.Number,
	estimated_call_count: Schema.Number,
	error_count: Schema.Number,
	error_rate: Schema.Number,
	avg_duration_ms: Schema.Number,
	max_duration_ms: Schema.Number,
	has_sampling: Schema.Boolean,
	sampling_weight: Schema.Number,
}).annotate({ identifier: "ServiceMapEdge", title: "Service map edge" })
export type V2ServiceMapEdge = Schema.Schema.Type<typeof V2ServiceMapEdge>
export const V2ServiceMap = Schema.Struct({
	object: Schema.Literal("service_map"),
	start_time: Timestamp,
	end_time: Timestamp,
	edges: Schema.Array(V2ServiceMapEdge),
}).annotate({ identifier: "ServiceMap", title: "Service map" })
export type V2ServiceMap = Schema.Schema.Type<typeof V2ServiceMap>
export const V2ServiceMapQuery = Schema.Struct({
	...V2TelemetryWindowQuery.fields,
	service_name: Schema.optional(ServiceName),
	deployment_environment: Schema.optional(Schema.String),
}).annotate({ identifier: "ServiceMapQuery", title: "Service map query" })
const ServiceList = ListOf(V2Service).annotate({
	identifier: "ServiceList",
	title: "Service list",
})

export class V2ServicesApiGroup extends HttpApiGroup.make("services")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: V2ServiceListQuery,
			success: ServiceList,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listServices",
				summary: "List services",
				description:
					"Lists services aggregated by name in an explicit time window. Requires `services:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:name", {
			params: { name: ServiceName },
			query: V2TelemetryWindowQuery,
			success: V2Service,
			error: [...commonErrors, V2NotFoundError],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getService",
				summary: "Retrieve a service",
				description:
					"Returns one service aggregated across environments and namespaces. Requires `services:read`.",
			}),
		),
	)
	.prefix("/v2/services")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Services",
			description: "Observed service health summaries.",
		}),
	) {}

export class V2ServiceMapApiGroup extends HttpApiGroup.make("serviceMap")
	.add(
		HttpApiEndpoint.get("retrieve", "/", {
			query: V2ServiceMapQuery,
			success: V2ServiceMap,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getServiceMap",
				summary: "Retrieve the service map",
				description:
					"Returns service-to-service dependencies in an explicit time window. Requires `service_map:read`.",
			}),
		),
	)
	.prefix("/v2/service_map")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Service Map",
			description: "Service-to-service topology.",
		}),
	) {}

const TracesMetric = Schema.Literals([
	"count",
	"avg_duration",
	"p50_duration",
	"p95_duration",
	"p99_duration",
	"error_rate",
	"apdex",
])
const TraceFilters = Schema.Struct({
	service_name: Schema.optionalKey(ServiceName),
	span_name: Schema.optionalKey(Schema.String),
	root_spans_only: Schema.optionalKey(Schema.Boolean),
	errors_only: Schema.optionalKey(Schema.Boolean),
	environments: Schema.optionalKey(Schema.Array(Schema.String)),
	namespaces: Schema.optionalKey(Schema.Array(Schema.String)),
	min_duration_ms: Schema.optionalKey(NonNegativeFinite),
	max_duration_ms: Schema.optionalKey(NonNegativeFinite),
	group_by_attribute_keys: Schema.optionalKey(Schema.Array(Schema.String)),
	attribute_filters: Schema.optionalKey(Schema.Array(V2AttributeFilter)),
	resource_attribute_filters: Schema.optionalKey(Schema.Array(V2AttributeFilter)),
})
const LogFilters = Schema.Struct({
	service_name: Schema.optionalKey(ServiceName),
	severity: Schema.optionalKey(Schema.String),
	trace_id: Schema.optionalKey(TraceId),
	search: Schema.optionalKey(Schema.String),
	environments: Schema.optionalKey(Schema.Array(Schema.String)),
	namespaces: Schema.optionalKey(Schema.Array(Schema.String)),
})
const MetricsFiltersSchema = Schema.Struct(MetricsFilters)

const V2TracesTimeseriesSpec = Schema.Struct({
	kind: Schema.Literal("timeseries"),
	source: Schema.Literal("traces"),
	metric: TracesMetric,
	group_by: Schema.optionalKey(
		Schema.Array(
			Schema.Literals(["service", "span_name", "status_code", "http_method", "attribute", "none"]),
		),
	),
	filters: Schema.optionalKey(TraceFilters),
	bucket_seconds: Schema.optionalKey(PositiveInteger),
	series_limit: Schema.optionalKey(TimeseriesSeriesLimit),
	apdex_threshold_ms: Schema.optionalKey(PositiveFinite),
})
const V2LogsTimeseriesSpec = Schema.Struct({
	kind: Schema.Literal("timeseries"),
	source: Schema.Literal("logs"),
	metric: Schema.Literal("count"),
	group_by: Schema.optionalKey(Schema.Array(Schema.Literals(["service", "severity", "none"]))),
	filters: Schema.optionalKey(LogFilters),
	bucket_seconds: Schema.optionalKey(PositiveInteger),
	series_limit: Schema.optionalKey(TimeseriesSeriesLimit),
})
const V2MetricsTimeseriesSpec = Schema.Struct({
	kind: Schema.Literal("timeseries"),
	source: Schema.Literal("metrics"),
	metric: MetricsMetric,
	group_by: Schema.optionalKey(
		Schema.Array(Schema.Literals(["service", "attribute", "resource_attribute", "none"])),
	),
	filters: MetricsFiltersSchema,
	bucket_seconds: Schema.optionalKey(PositiveInteger),
	series_limit: Schema.optionalKey(TimeseriesSeriesLimit),
})
const V2TracesBreakdownSpec = Schema.Struct({
	kind: Schema.Literal("breakdown"),
	source: Schema.Literal("traces"),
	metric: TracesMetric,
	group_by: Schema.Literals(["service", "span_name", "status_code", "http_method", "attribute"]),
	filters: Schema.optionalKey(TraceFilters),
	limit: Schema.optionalKey(BreakdownLimit),
	apdex_threshold_ms: Schema.optionalKey(PositiveFinite),
})
const V2LogsBreakdownSpec = Schema.Struct({
	kind: Schema.Literal("breakdown"),
	source: Schema.Literal("logs"),
	metric: Schema.Literal("count"),
	group_by: Schema.Literals(["service", "severity"]),
	filters: Schema.optionalKey(LogFilters),
	limit: Schema.optionalKey(BreakdownLimit),
})
const V2MetricsBreakdownSpec = Schema.Struct({
	kind: Schema.Literal("breakdown"),
	source: Schema.Literal("metrics"),
	metric: Schema.Literals(["avg", "sum", "count"]),
	group_by: Schema.Literals(["service", "attribute", "resource_attribute"]),
	filters: MetricsFiltersSchema,
	limit: Schema.optionalKey(BreakdownLimit),
})
export const V2QuerySpec = Schema.Union([
	V2TracesTimeseriesSpec,
	V2LogsTimeseriesSpec,
	V2MetricsTimeseriesSpec,
	V2TracesBreakdownSpec,
	V2LogsBreakdownSpec,
	V2MetricsBreakdownSpec,
]).annotate({ identifier: "QuerySpec", title: "Query specification" })
export type V2QuerySpec = Schema.Schema.Type<typeof V2QuerySpec>
export const V2QueryParams = Schema.Struct({
	...RequiredTimeRange,
	query: V2QuerySpec,
}).annotate({ identifier: "QueryParams", title: "Query parameters" })
export class V2QueryApiGroup extends HttpApiGroup.make("query")
	.add(
		HttpApiEndpoint.post("execute", "/", {
			payload: V2QueryParams,
			success: V2StructuredQueryResult,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "executeQuery",
				summary: "Execute a telemetry query",
				description: "Executes a typed telemetry query. Requires `query:read`.",
			}),
		),
	)
	.prefix("/v2/query")
	.middleware(AuthorizationV2)
	.middleware(V2SchemaErrors)
	.annotateMerge(
		OpenApi.annotations({
			title: "Query",
			description: "Structured telemetry query execution.",
		}),
	) {}
