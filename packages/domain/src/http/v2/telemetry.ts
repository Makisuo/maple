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
const NonEmptyString = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed())

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

export const V2AttributeFilter = Schema.Union([
	Schema.Struct({
		key: NonEmptyString,
		operator: Schema.Literal("exists"),
		value: Schema.optionalKey(Schema.Never),
		negated: Schema.optionalKey(Schema.Boolean),
	}),
	Schema.Struct({
		key: NonEmptyString,
		operator: Schema.Literals(["equals", "contains"]),
		value: Schema.String,
		negated: Schema.optionalKey(Schema.Boolean),
	}),
	Schema.Struct({
		key: NonEmptyString,
		operator: Schema.Literals(["gt", "gte", "lt", "lte"]),
		value: Schema.Number.check(Schema.isFinite()),
		negated: Schema.optionalKey(Schema.Boolean),
	}),
]).annotate({
	identifier: "AttributeFilter",
	title: "Attribute filter",
	description:
		"Matches an attribute by key. `exists` has no value, string operators require a string value, and numeric operators require a finite number.",
})
export type V2AttributeFilter = Schema.Schema.Type<typeof V2AttributeFilter>
const AttributeFilterCollection = Schema.Array(V2AttributeFilter).check(Schema.isMaxLength(20))

const TraceFilters = Schema.Struct({
	service_name: Schema.optionalKey(ServiceName),
	span_name: Schema.optionalKey(NonEmptyString),
	status_code: Schema.optionalKey(Schema.Literals(["Ok", "Error", "Unset"])),
	has_error: Schema.optionalKey(Schema.Boolean),
	min_duration_ms: Schema.optionalKey(NonNegativeFinite),
	max_duration_ms: Schema.optionalKey(NonNegativeFinite),
	http_method: Schema.optionalKey(NonEmptyString),
	http_route: Schema.optionalKey(NonEmptyString),
	http_status_code: Schema.optionalKey(NonEmptyString),
	deployment_environment: Schema.optionalKey(NonEmptyString),
	service_namespace: Schema.optionalKey(NonEmptyString),
	span_scope: Schema.optionalKey(Schema.Literal("root")),
	attributes: Schema.optionalKey(AttributeFilterCollection),
	resource_attributes: Schema.optionalKey(AttributeFilterCollection),
}).annotate({ identifier: "TraceFilters", title: "Trace filters" })

const LogFilters = Schema.Struct({
	service_name: Schema.optionalKey(ServiceName),
	severity: Schema.optionalKey(NonEmptyString),
	minimum_severity: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 255 })),
	),
	trace_id: Schema.optionalKey(TraceId),
	span_id: Schema.optionalKey(SpanId),
	body_search: Schema.optionalKey(NonEmptyString),
	deployment_environment: Schema.optionalKey(NonEmptyString),
	service_namespace: Schema.optionalKey(NonEmptyString),
	attributes: Schema.optionalKey(AttributeFilterCollection),
	resource_attributes: Schema.optionalKey(AttributeFilterCollection),
}).annotate({ identifier: "LogFilters", title: "Log filters" })

const MetricType = Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"])
const MetricFilters = Schema.Struct({
	metric_name: MetricName,
	metric_type: MetricType,
	service_name: Schema.optionalKey(ServiceName),
}).annotate({ identifier: "MetricFilters", title: "Metric filters" })

export const V2TimeseriesValuePoint = Schema.Struct({
	timestamp: Timestamp,
	value: Schema.Number,
}).annotate({ identifier: "TimeseriesValuePoint", title: "Timeseries value point" })
export const V2TimeseriesSeries = Schema.Struct({
	group: Schema.NullOr(Schema.String),
	points: Schema.Array(V2TimeseriesValuePoint),
}).annotate({ identifier: "TimeseriesSeries", title: "Timeseries series" })
export const V2BreakdownItem = Schema.Struct({
	name: Schema.String,
	value: Schema.Number,
}).annotate({ identifier: "BreakdownItem", title: "Breakdown item" })

const traceAggregations = [
	"count",
	"avg_duration",
	"p50_duration",
	"p95_duration",
	"p99_duration",
	"error_rate",
	"apdex",
] as const
const traceGroupBy = ["service", "span_name", "status_code", "http_method", "attribute"] as const
const metricTimeseriesAggregations = ["avg", "sum", "min", "max", "count", "rate", "increase"] as const
const metricBreakdownAggregations = ["avg", "sum", "count"] as const

const V2TraceTimeseriesParamsBase = Schema.Struct({
	...RequiredTimeRange,
	aggregation: Schema.Literals(traceAggregations),
	filters: Schema.optionalKey(TraceFilters),
	group_by: Schema.optionalKey(Schema.Literals(traceGroupBy)),
	group_by_attribute_key: Schema.optionalKey(NonEmptyString),
	bucket_seconds: Schema.optionalKey(PositiveInteger),
	series_limit: Schema.optionalKey(TimeseriesSeriesLimit),
	apdex_threshold_ms: Schema.optionalKey(PositiveFinite),
})
export const V2TraceTimeseriesParams = V2TraceTimeseriesParamsBase.check(
	Schema.makeFilter((value) => value.group_by !== "attribute" || !!value.group_by_attribute_key, {
		message: "group_by=attribute requires group_by_attribute_key",
	}),
).annotate({
	identifier: "TraceTimeseriesParams",
	title: "Trace timeseries parameters",
	examples: [
		wireExample({
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			aggregation: "p95_duration",
			filters: { service_name: "api" },
			group_by: "span_name",
			bucket_seconds: 60,
			series_limit: 50,
		}),
	],
})

const V2TraceBreakdownParamsBase = Schema.Struct({
	...RequiredTimeRange,
	aggregation: Schema.Literals(traceAggregations),
	filters: Schema.optionalKey(TraceFilters),
	group_by: Schema.Literals(traceGroupBy),
	group_by_attribute_key: Schema.optionalKey(NonEmptyString),
	limit: Schema.optionalKey(BreakdownLimit),
	apdex_threshold_ms: Schema.optionalKey(PositiveFinite),
})
export const V2TraceBreakdownParams = V2TraceBreakdownParamsBase.check(
	Schema.makeFilter((value) => value.group_by !== "attribute" || !!value.group_by_attribute_key, {
		message: "group_by=attribute requires group_by_attribute_key",
	}),
).annotate({
	identifier: "TraceBreakdownParams",
	title: "Trace breakdown parameters",
	examples: [
		wireExample({
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			aggregation: "error_rate",
			group_by: "service",
			limit: 20,
		}),
	],
})

export const V2LogTimeseriesParams = Schema.Struct({
	...RequiredTimeRange,
	aggregation: Schema.Literal("count"),
	filters: Schema.optionalKey(LogFilters),
	group_by: Schema.optionalKey(Schema.Literals(["service", "severity"])),
	bucket_seconds: Schema.optionalKey(PositiveInteger),
	series_limit: Schema.optionalKey(TimeseriesSeriesLimit),
}).annotate({
	identifier: "LogTimeseriesParams",
	title: "Log timeseries parameters",
	examples: [
		wireExample({
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			aggregation: "count",
			filters: { minimum_severity: 17 },
			group_by: "severity",
		}),
	],
})

export const V2LogBreakdownParams = Schema.Struct({
	...RequiredTimeRange,
	aggregation: Schema.Literal("count"),
	filters: Schema.optionalKey(LogFilters),
	group_by: Schema.Literals(["service", "severity"]),
	limit: Schema.optionalKey(BreakdownLimit),
}).annotate({
	identifier: "LogBreakdownParams",
	title: "Log breakdown parameters",
	examples: [
		wireExample({
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			aggregation: "count",
			group_by: "service",
			limit: 20,
		}),
	],
})

const V2MetricsTimeseriesParamsBase = Schema.Struct({
	...RequiredTimeRange,
	aggregation: Schema.Literals(metricTimeseriesAggregations),
	filters: MetricFilters,
	group_by: Schema.optionalKey(Schema.Literals(["service", "attribute", "resource_attribute"])),
	group_by_attribute_key: Schema.optionalKey(NonEmptyString),
	group_by_resource_attribute_key: Schema.optionalKey(NonEmptyString),
	bucket_seconds: Schema.optionalKey(PositiveInteger),
	series_limit: Schema.optionalKey(TimeseriesSeriesLimit),
})
export const V2MetricsTimeseriesParams = V2MetricsTimeseriesParamsBase.check(
	Schema.makeFilter(
		(value) =>
			(value.group_by !== "attribute" || !!value.group_by_attribute_key) &&
			(value.group_by !== "resource_attribute" || !!value.group_by_resource_attribute_key) &&
			((value.aggregation !== "rate" && value.aggregation !== "increase") ||
				value.filters.metric_type === "sum"),
		{
			message:
				"Attribute grouping requires its attribute key, and rate/increase require filters.metric_type to be sum",
		},
	),
).annotate({
	identifier: "MetricsTimeseriesParams",
	title: "Metrics timeseries parameters",
	examples: [
		wireExample({
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			aggregation: "avg",
			filters: { metric_name: "http.server.duration", metric_type: "histogram" },
			group_by: "service",
		}),
	],
})

const V2MetricsBreakdownParamsBase = Schema.Struct({
	...RequiredTimeRange,
	aggregation: Schema.Literals(metricBreakdownAggregations),
	filters: MetricFilters,
	group_by: Schema.Literals(["service", "attribute", "resource_attribute"]),
	group_by_attribute_key: Schema.optionalKey(NonEmptyString),
	group_by_resource_attribute_key: Schema.optionalKey(NonEmptyString),
	limit: Schema.optionalKey(BreakdownLimit),
})
export const V2MetricsBreakdownParams = V2MetricsBreakdownParamsBase.check(
	Schema.makeFilter(
		(value) =>
			(value.group_by !== "attribute" || !!value.group_by_attribute_key) &&
			(value.group_by !== "resource_attribute" || !!value.group_by_resource_attribute_key),
		{ message: "Attribute grouping requires the corresponding attribute key" },
	),
).annotate({
	identifier: "MetricsBreakdownParams",
	title: "Metrics breakdown parameters",
	examples: [
		wireExample({
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			aggregation: "sum",
			filters: { metric_name: "http.server.request.size", metric_type: "histogram" },
			group_by: "service",
		}),
	],
})

const timeseriesResultFields = {
	start_time: Timestamp,
	end_time: Timestamp,
	bucket_seconds: PositiveInteger,
	group_by: Schema.NullOr(Schema.String),
	series: Schema.Array(V2TimeseriesSeries),
} as const
const breakdownResultFields = {
	start_time: Timestamp,
	end_time: Timestamp,
	group_by: Schema.String,
	data: Schema.Array(V2BreakdownItem),
} as const

export const V2TraceTimeseriesResult = Schema.Struct({
	object: Schema.Literal("trace_timeseries"),
	aggregation: Schema.Literals(traceAggregations),
	...timeseriesResultFields,
}).annotate({
	identifier: "TraceTimeseriesResult",
	title: "Trace timeseries result",
	examples: [
		wireExample({
			object: "trace_timeseries",
			aggregation: "count",
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			bucket_seconds: 60,
			group_by: "service",
			series: [{ group: "api", points: [{ timestamp: "2026-07-15T12:00:00.000Z", value: 42 }] }],
		}),
	],
})
export const V2TraceBreakdownResult = Schema.Struct({
	object: Schema.Literal("trace_breakdown"),
	aggregation: Schema.Literals(traceAggregations),
	...breakdownResultFields,
}).annotate({
	identifier: "TraceBreakdownResult",
	title: "Trace breakdown result",
	examples: [
		wireExample({
			object: "trace_breakdown",
			aggregation: "error_rate",
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			group_by: "service",
			data: [{ name: "api", value: 0.05 }],
		}),
	],
})
export const V2LogTimeseriesResult = Schema.Struct({
	object: Schema.Literal("log_timeseries"),
	aggregation: Schema.Literal("count"),
	...timeseriesResultFields,
}).annotate({
	identifier: "LogTimeseriesResult",
	title: "Log timeseries result",
	examples: [
		wireExample({
			object: "log_timeseries",
			aggregation: "count",
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			bucket_seconds: 60,
			group_by: null,
			series: [{ group: null, points: [{ timestamp: "2026-07-15T12:00:00.000Z", value: 10 }] }],
		}),
	],
})
export const V2LogBreakdownResult = Schema.Struct({
	object: Schema.Literal("log_breakdown"),
	aggregation: Schema.Literal("count"),
	...breakdownResultFields,
}).annotate({
	identifier: "LogBreakdownResult",
	title: "Log breakdown result",
	examples: [
		wireExample({
			object: "log_breakdown",
			aggregation: "count",
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			group_by: "severity",
			data: [{ name: "ERROR", value: 10 }],
		}),
	],
})
export const V2MetricTimeseriesResult = Schema.Struct({
	object: Schema.Literal("metric_timeseries"),
	aggregation: Schema.Literals(metricTimeseriesAggregations),
	...timeseriesResultFields,
}).annotate({
	identifier: "MetricTimeseriesResult",
	title: "Metric timeseries result",
	examples: [
		wireExample({
			object: "metric_timeseries",
			aggregation: "avg",
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			bucket_seconds: 60,
			group_by: "service",
			series: [{ group: "api", points: [{ timestamp: "2026-07-15T12:00:00.000Z", value: 42 }] }],
		}),
	],
})
export const V2MetricBreakdownResult = Schema.Struct({
	object: Schema.Literal("metric_breakdown"),
	aggregation: Schema.Literals(metricBreakdownAggregations),
	...breakdownResultFields,
}).annotate({
	identifier: "MetricBreakdownResult",
	title: "Metric breakdown result",
	examples: [
		wireExample({
			object: "metric_breakdown",
			aggregation: "sum",
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			group_by: "service",
			data: [{ name: "api", value: 420 }],
		}),
	],
})

export type V2TraceTimeseriesResult = Schema.Schema.Type<typeof V2TraceTimeseriesResult>
export type V2TraceBreakdownResult = Schema.Schema.Type<typeof V2TraceBreakdownResult>
export type V2LogTimeseriesResult = Schema.Schema.Type<typeof V2LogTimeseriesResult>
export type V2LogBreakdownResult = Schema.Schema.Type<typeof V2LogBreakdownResult>
export type V2MetricTimeseriesResult = Schema.Schema.Type<typeof V2MetricTimeseriesResult>
export type V2MetricBreakdownResult = Schema.Schema.Type<typeof V2MetricBreakdownResult>

export const V2TraceSummary = Schema.Struct({
	id: TraceId,
	object: Schema.Literal("trace"),
	start_time: Timestamp,
	duration_ms: Schema.Number,
	root_span_name: Schema.String,
	root_span_kind: Schema.String,
	root_service_name: Schema.String,
	root_status_code: Schema.String,
	root_has_error: Schema.Boolean,
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
			root_status_code: "Ok",
			root_has_error: false,
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
	filters: Schema.optionalKey(TraceFilters),
}).annotate({
	identifier: "TraceSearchParams",
	title: "Trace search parameters",
	examples: [
		wireExample({
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			filters: {
				service_name: "api",
				has_error: true,
				attributes: [{ key: "http.route", operator: "contains", value: "/checkout" }],
			},
			limit: 20,
		}),
	],
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
		HttpApiEndpoint.post("timeseries", "/timeseries", {
			payload: V2TraceTimeseriesParams,
			success: V2TraceTimeseriesResult,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "queryTraceTimeseries",
				summary: "Query trace timeseries",
				description: "Aggregates traces into chronological series. Requires `traces:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("breakdown", "/breakdown", {
			payload: V2TraceBreakdownParams,
			success: V2TraceBreakdownResult,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "queryTraceBreakdown",
				summary: "Query trace breakdown",
				description: "Aggregates traces by one dimension. Requires `traces:read`.",
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
	filters: Schema.optionalKey(LogFilters),
}).annotate({
	identifier: "LogSearchParams",
	title: "Log search parameters",
	examples: [
		wireExample({
			start_time: "2026-07-15T12:00:00.000Z",
			end_time: "2026-07-15T13:00:00.000Z",
			filters: { service_name: "api", minimum_severity: 17, body_search: "checkout" },
			limit: 20,
		}),
	],
})
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
		HttpApiEndpoint.post("timeseries", "/timeseries", {
			payload: V2LogTimeseriesParams,
			success: V2LogTimeseriesResult,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "queryLogTimeseries",
				summary: "Query log timeseries",
				description: "Counts logs in chronological buckets. Requires `logs:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("breakdown", "/breakdown", {
			payload: V2LogBreakdownParams,
			success: V2LogBreakdownResult,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "queryLogBreakdown",
				summary: "Query log breakdown",
				description: "Counts logs by service or severity. Requires `logs:read`.",
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
			success: V2MetricTimeseriesResult,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "queryMetricsTimeseries",
				summary: "Query metric timeseries",
				description: "Executes one typed metric timeseries query. Requires `metrics:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("breakdown", "/breakdown", {
			payload: V2MetricsBreakdownParams,
			success: V2MetricBreakdownResult,
			error: [...commonErrors],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "queryMetricBreakdown",
				summary: "Query metric breakdown",
				description: "Aggregates one metric by a single dimension. Requires `metrics:read`.",
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
