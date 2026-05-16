import { Schema } from "effect"

const dateTimePattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

export const TinybirdDateTime = Schema.String.pipe(
	Schema.check(Schema.isPattern(dateTimePattern)),
	Schema.annotate({
		identifier: "TinybirdDateTime",
		description: "Date time string in YYYY-MM-DD HH:mm:ss format",
	}),
)

export const TracesMetric = Schema.Literals([
	"count",
	"avg_duration",
	"p50_duration",
	"p95_duration",
	"p99_duration",
	"error_rate",
	"apdex",
])
export type TracesMetric = Schema.Schema.Type<typeof TracesMetric>

export const MetricsMetric = Schema.Literals(["avg", "sum", "min", "max", "count", "rate", "increase"])
export type MetricsMetric = Schema.Schema.Type<typeof MetricsMetric>

export const MetricType = Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"])
export type MetricType = Schema.Schema.Type<typeof MetricType>

export const AttributeFilter = Schema.Struct({
	key: Schema.String,
	value: Schema.optionalKey(Schema.String),
	mode: Schema.Literals(["equals", "exists", "gt", "gte", "lt", "lte", "contains"]),
	negated: Schema.optionalKey(Schema.Boolean),
})
export type AttributeFilter = Schema.Schema.Type<typeof AttributeFilter>

export const TracesMatchModes = Schema.Struct({
	serviceName: Schema.optionalKey(Schema.Literals(["contains"])),
	spanName: Schema.optionalKey(Schema.Literals(["contains"])),
	deploymentEnv: Schema.optionalKey(Schema.Literals(["contains"])),
})
export type TracesMatchModes = Schema.Schema.Type<typeof TracesMatchModes>

export const TracesFilters = Schema.Struct({
	serviceName: Schema.optionalKey(Schema.String),
	spanName: Schema.optionalKey(Schema.String),
	rootSpansOnly: Schema.optionalKey(Schema.Boolean),
	environments: Schema.optionalKey(Schema.Array(Schema.String)),
	commitShas: Schema.optionalKey(Schema.Array(Schema.String)),
	groupByAttributeKeys: Schema.optionalKey(Schema.Array(Schema.String)),
	errorsOnly: Schema.optionalKey(Schema.Boolean),
	minDurationMs: Schema.optionalKey(Schema.Number),
	maxDurationMs: Schema.optionalKey(Schema.Number),
	matchModes: Schema.optionalKey(TracesMatchModes),
	attributeFilters: Schema.optionalKey(Schema.Array(AttributeFilter)),
	resourceAttributeFilters: Schema.optionalKey(Schema.Array(AttributeFilter)),
	excludedServiceNames: Schema.optionalKey(Schema.Array(Schema.String)),
	excludedSpanNames: Schema.optionalKey(Schema.Array(Schema.String)),
	excludedEnvironments: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type TracesFilters = Schema.Schema.Type<typeof TracesFilters>

export const LogsFilters = Schema.Struct({
	serviceName: Schema.optionalKey(Schema.String),
	severity: Schema.optionalKey(Schema.String),
	traceId: Schema.optionalKey(Schema.String),
	search: Schema.optionalKey(Schema.String),
	environments: Schema.optionalKey(Schema.Array(Schema.String)),
	deploymentEnvMatchMode: Schema.optionalKey(Schema.Literal("contains")),
})
export type LogsFilters = Schema.Schema.Type<typeof LogsFilters>

export const ErrorsFilters = Schema.Struct({
	rootOnly: Schema.optionalKey(Schema.Boolean),
	services: Schema.optionalKey(Schema.Array(Schema.String)),
	deploymentEnvs: Schema.optionalKey(Schema.Array(Schema.String)),
	errorTypes: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type ErrorsFilters = Schema.Schema.Type<typeof ErrorsFilters>

export const MetricsFilters = Schema.Struct({
	metricName: Schema.String,
	metricType: MetricType,
	serviceName: Schema.optionalKey(Schema.String),
	groupByAttributeKey: Schema.optionalKey(Schema.String),
	attributeFilters: Schema.optionalKey(Schema.Array(AttributeFilter)),
})
export type MetricsFilters = Schema.Schema.Type<typeof MetricsFilters>

export const TracesTimeseriesQuery = Schema.Struct({
	kind: Schema.Literal("timeseries"),
	source: Schema.Literal("traces"),
	metric: TracesMetric,
	allMetrics: Schema.optionalKey(Schema.Boolean),
	apdexThresholdMs: Schema.optionalKey(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
	groupBy: Schema.optionalKey(
		Schema.Array(
			Schema.Literals(["service", "span_name", "status_code", "http_method", "attribute", "none"]),
		),
	),
	filters: Schema.optionalKey(TracesFilters),
	bucketSeconds: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
})
export type TracesTimeseriesQuery = Schema.Schema.Type<typeof TracesTimeseriesQuery>

export const LogsTimeseriesQuery = Schema.Struct({
	kind: Schema.Literal("timeseries"),
	source: Schema.Literal("logs"),
	metric: Schema.Literal("count"),
	groupBy: Schema.optionalKey(Schema.Array(Schema.Literals(["service", "severity", "none"]))),
	filters: Schema.optionalKey(LogsFilters),
	bucketSeconds: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
})
export type LogsTimeseriesQuery = Schema.Schema.Type<typeof LogsTimeseriesQuery>

export const MetricsTimeseriesQuery = Schema.Struct({
	kind: Schema.Literal("timeseries"),
	source: Schema.Literal("metrics"),
	metric: MetricsMetric,
	groupBy: Schema.optionalKey(Schema.Array(Schema.Literals(["service", "attribute", "none"]))),
	filters: MetricsFilters,
	bucketSeconds: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
})
export type MetricsTimeseriesQuery = Schema.Schema.Type<typeof MetricsTimeseriesQuery>

export const TracesBreakdownQuery = Schema.Struct({
	kind: Schema.Literal("breakdown"),
	source: Schema.Literal("traces"),
	metric: TracesMetric,
	apdexThresholdMs: Schema.optionalKey(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
	groupBy: Schema.Literals(["service", "span_name", "status_code", "http_method", "attribute"]),
	filters: Schema.optionalKey(TracesFilters),
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
	),
})
export type TracesBreakdownQuery = Schema.Schema.Type<typeof TracesBreakdownQuery>

export const LogsBreakdownQuery = Schema.Struct({
	kind: Schema.Literal("breakdown"),
	source: Schema.Literal("logs"),
	metric: Schema.Literal("count"),
	groupBy: Schema.Literals(["service", "severity"]),
	filters: Schema.optionalKey(LogsFilters),
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
	),
})
export type LogsBreakdownQuery = Schema.Schema.Type<typeof LogsBreakdownQuery>

export const MetricsBreakdownQuery = Schema.Struct({
	kind: Schema.Literal("breakdown"),
	source: Schema.Literal("metrics"),
	metric: Schema.Literals(["avg", "sum", "count"]),
	groupBy: Schema.Literal("service"),
	filters: MetricsFilters,
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100)),
	),
})
export type MetricsBreakdownQuery = Schema.Schema.Type<typeof MetricsBreakdownQuery>

export const TracesListQuery = Schema.Struct({
	kind: Schema.Literal("list"),
	source: Schema.Literal("traces"),
	filters: Schema.optionalKey(TracesFilters),
	columns: Schema.optionalKey(Schema.Array(Schema.String)),
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(200)),
	),
	offset: Schema.optionalKey(
		Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThanOrEqualTo(0),
			Schema.isLessThanOrEqualTo(1000),
		),
	),
	cursor: Schema.optionalKey(Schema.String),
})
export type TracesListQuery = Schema.Schema.Type<typeof TracesListQuery>

export const LogsListQuery = Schema.Struct({
	kind: Schema.Literal("list"),
	source: Schema.Literal("logs"),
	filters: Schema.optionalKey(LogsFilters),
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(200)),
	),
	cursor: Schema.optionalKey(Schema.String),
})
export type LogsListQuery = Schema.Schema.Type<typeof LogsListQuery>

export const AttributeKeysQuery = Schema.Struct({
	kind: Schema.Literal("attributeKeys"),
	source: Schema.Literals(["traces", "logs", "metrics"]),
	scope: Schema.optionalKey(Schema.Literals(["span", "resource"])),
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(500)),
	),
})
export type AttributeKeysQuery = Schema.Schema.Type<typeof AttributeKeysQuery>

export const TracesFacetsQuery = Schema.Struct({
	kind: Schema.Literal("facets"),
	source: Schema.Literal("traces"),
	filters: Schema.optionalKey(TracesFilters),
})
export type TracesFacetsQuery = Schema.Schema.Type<typeof TracesFacetsQuery>

export const LogsFacetsQuery = Schema.Struct({
	kind: Schema.Literal("facets"),
	source: Schema.Literal("logs"),
	filters: Schema.optionalKey(LogsFilters),
})
export type LogsFacetsQuery = Schema.Schema.Type<typeof LogsFacetsQuery>

export const ErrorsFacetsQuery = Schema.Struct({
	kind: Schema.Literal("facets"),
	source: Schema.Literal("errors"),
	filters: Schema.optionalKey(ErrorsFilters),
})
export type ErrorsFacetsQuery = Schema.Schema.Type<typeof ErrorsFacetsQuery>

export const ServicesFacetsQuery = Schema.Struct({
	kind: Schema.Literal("facets"),
	source: Schema.Literal("services"),
})
export type ServicesFacetsQuery = Schema.Schema.Type<typeof ServicesFacetsQuery>

export const TracesStatsQuery = Schema.Struct({
	kind: Schema.Literal("stats"),
	source: Schema.Literal("traces"),
	filters: Schema.optionalKey(TracesFilters),
})
export type TracesStatsQuery = Schema.Schema.Type<typeof TracesStatsQuery>

export const AttributeValuesQuery = Schema.Struct({
	kind: Schema.Literal("attributeValues"),
	source: Schema.Literals(["traces", "logs", "metrics"]),
	scope: Schema.Literals(["span", "resource", "log", "metric"]),
	attributeKey: Schema.String,
	limit: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(500)),
	),
})
export type AttributeValuesQuery = Schema.Schema.Type<typeof AttributeValuesQuery>

export const LogsCountQuery = Schema.Struct({
	kind: Schema.Literal("count"),
	source: Schema.Literal("logs"),
	filters: Schema.optionalKey(LogsFilters),
})
export type LogsCountQuery = Schema.Schema.Type<typeof LogsCountQuery>

export const QuerySpec = Schema.Union([
	TracesTimeseriesQuery,
	LogsTimeseriesQuery,
	MetricsTimeseriesQuery,
	TracesBreakdownQuery,
	LogsBreakdownQuery,
	MetricsBreakdownQuery,
	TracesListQuery,
	LogsListQuery,
	AttributeKeysQuery,
	TracesFacetsQuery,
	LogsFacetsQuery,
	ErrorsFacetsQuery,
	ServicesFacetsQuery,
	TracesStatsQuery,
	AttributeValuesQuery,
	LogsCountQuery,
])
export type QuerySpec = Schema.Schema.Type<typeof QuerySpec>

export class QueryEngineExecuteRequest extends Schema.Class<QueryEngineExecuteRequest>(
	"QueryEngineExecuteRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	query: QuerySpec,
}) {}

export const TimeseriesPoint = Schema.Struct({
	bucket: Schema.String,
	series: Schema.Record(Schema.String, Schema.Number),
})
export type TimeseriesPoint = Schema.Schema.Type<typeof TimeseriesPoint>

export const BreakdownItem = Schema.Struct({
	name: Schema.String,
	value: Schema.Number,
})
export type BreakdownItem = Schema.Schema.Type<typeof BreakdownItem>

export const ListRow = Schema.Record(Schema.String, Schema.Unknown)
export type ListRow = Schema.Schema.Type<typeof ListRow>

export const AttributeKeyItem = Schema.Struct({
	key: Schema.String,
	count: Schema.Number,
})
export type AttributeKeyItem = Schema.Schema.Type<typeof AttributeKeyItem>

export const FacetItem = Schema.Struct({
	facetType: Schema.String,
	name: Schema.String,
	count: Schema.Number,
})
export type FacetItem = Schema.Schema.Type<typeof FacetItem>

export const DurationStats = Schema.Struct({
	minDurationMs: Schema.Number,
	maxDurationMs: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
})
export type DurationStats = Schema.Schema.Type<typeof DurationStats>

export const AttributeValueItem = Schema.Struct({
	value: Schema.String,
	count: Schema.Number,
})
export type AttributeValueItem = Schema.Schema.Type<typeof AttributeValueItem>

export const QueryEngineResult = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("timeseries"),
		source: Schema.Literals(["traces", "logs", "metrics"]),
		data: Schema.Array(TimeseriesPoint),
	}),
	Schema.Struct({
		kind: Schema.Literal("breakdown"),
		source: Schema.Literals(["traces", "logs", "metrics"]),
		data: Schema.Array(BreakdownItem),
	}),
	Schema.Struct({
		kind: Schema.Literal("list"),
		source: Schema.Literals(["traces", "logs"]),
		data: Schema.Array(ListRow),
	}),
	Schema.Struct({
		kind: Schema.Literal("attributeKeys"),
		source: Schema.Literals(["traces", "logs", "metrics"]),
		data: Schema.Array(AttributeKeyItem),
	}),
	Schema.Struct({
		kind: Schema.Literal("facets"),
		source: Schema.Literals(["traces", "logs", "errors", "services"]),
		data: Schema.Array(FacetItem),
	}),
	Schema.Struct({
		kind: Schema.Literal("stats"),
		source: Schema.Literal("traces"),
		data: DurationStats,
	}),
	Schema.Struct({
		kind: Schema.Literal("attributeValues"),
		source: Schema.Literals(["traces", "logs", "metrics"]),
		data: Schema.Array(AttributeValueItem),
	}),
	Schema.Struct({
		kind: Schema.Literal("count"),
		source: Schema.Literal("logs"),
		data: Schema.Struct({ total: Schema.Number }),
	}),
])
export type QueryEngineResult = Schema.Schema.Type<typeof QueryEngineResult>

export class QueryEngineExecuteResponse extends Schema.Class<QueryEngineExecuteResponse>(
	"QueryEngineExecuteResponse",
)({
	result: QueryEngineResult,
}) {}

export const QueryEngineAlertReducer = Schema.Literals(["identity", "sum", "avg", "min", "max"]).annotate({
	identifier: "@maple/QueryEngineAlertReducer",
})
export type QueryEngineAlertReducer = Schema.Schema.Type<typeof QueryEngineAlertReducer>

export const QueryEngineSampleCountStrategy = Schema.Literals([
	"trace_count",
	"metric_data_points",
	"log_count",
]).annotate({
	identifier: "@maple/QueryEngineSampleCountStrategy",
})
export type QueryEngineSampleCountStrategy = Schema.Schema.Type<typeof QueryEngineSampleCountStrategy>

export const QueryEngineNoDataBehavior = Schema.Literals(["skip", "zero"]).annotate({
	identifier: "@maple/QueryEngineNoDataBehavior",
})
export type QueryEngineNoDataBehavior = Schema.Schema.Type<typeof QueryEngineNoDataBehavior>

export const QueryEngineAlertObservation = Schema.Struct({
	value: Schema.NullOr(Schema.Number),
	sampleCount: Schema.Number,
	hasData: Schema.Boolean,
	label: Schema.optionalKey(Schema.String),
})
export type QueryEngineAlertObservation = Schema.Schema.Type<typeof QueryEngineAlertObservation>

export class QueryEngineEvaluateRequest extends Schema.Class<QueryEngineEvaluateRequest>(
	"QueryEngineEvaluateRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	query: QuerySpec,
	reducer: QueryEngineAlertReducer,
	sampleCountStrategy: QueryEngineSampleCountStrategy,
}) {}

export class QueryEngineEvaluateResponse extends Schema.Class<QueryEngineEvaluateResponse>(
	"QueryEngineEvaluateResponse",
)({
	value: Schema.NullOr(Schema.Number),
	sampleCount: Schema.Number,
	hasData: Schema.Boolean,
	reason: Schema.optionalKey(Schema.String),
	reducer: QueryEngineAlertReducer,
	observations: Schema.Array(QueryEngineAlertObservation),
}) {}

/**
 * Compiled, evaluation-ready form of an alert rule's query.
 *
 * - `kind: "spec"` — a structured QueryEngine `QuerySpec` (built from a query
 *   builder draft or one of the canned signal types). Evaluated via
 *   `QueryEngineService.evaluate`.
 * - `kind: "raw_sql"` — user-authored ClickHouse SQL with macros. Evaluated via
 *   `QueryEngineService.evaluateRawSql`. `query`/`sampleCountStrategy` are null;
 *   the alert value comes from the `value` column convention.
 */
export class CompiledAlertQueryPlan extends Schema.Class<CompiledAlertQueryPlan>("CompiledAlertQueryPlan")({
	kind: Schema.Literals(["spec", "raw_sql"]),
	query: Schema.NullOr(QuerySpec),
	rawSql: Schema.NullOr(Schema.String),
	reducer: QueryEngineAlertReducer,
	sampleCountStrategy: Schema.NullOr(QueryEngineSampleCountStrategy),
	noDataBehavior: QueryEngineNoDataBehavior,
}) {}
