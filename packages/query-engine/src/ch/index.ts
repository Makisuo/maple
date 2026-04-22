// ---------------------------------------------------------------------------
// ClickHouse Query DSL — Public API
// ---------------------------------------------------------------------------

// Types
export {
  type CHType,
  type CHString,
  type CHUInt8,
  type CHUInt64,
  type CHFloat64,
  type CHDateTime,
  type CHDateTime64,
  type CHMap,
  type CHArray,
  type CHNullable,
  type InferTS,
  type ColumnDefs,
  type OutputToColumnDefs,
  type NullableColumnDefs,
  string,
  uint8,
  uint64,
  float64,
  dateTime,
  dateTime64,
  map,
  array,
  nullable,
} from "./types"

// Table
export { type Table, table } from "./table"

// Core expression primitives
export {
  type Expr,
  type ColumnRef,
  type Condition,
  lit,
  rawExpr,
  rawCond,
  when,
  whenTrue,
  inList,
  exists,
  inSubquery,
  outerRef,
} from "./expr"

// Function factories (for extensibility by package consumers)
export { defineFn, defineCondFn, compileFnCall, compileFnCallCond, makeExpr, makeCond } from "./define-fn"

// ClickHouse functions (from category modules)
export {
  // Aggregate
  count,
  countIf,
  avg,
  sum,
  min_ as min,
  max_ as max,
  quantile,
  any_ as any,
  anyIf,
  uniq,
  sumIf,
  groupUniqArray,
  // String
  toString_ as toString,
  positionCaseInsensitive,
  position_ as position,
  left_ as left,
  length_ as length,
  replaceOne,
  extract_ as extract,
  concat,
  // Numeric
  round_,
  intDiv,
  toFloat64OrZero,
  toUInt16OrZero,
  toUInt64,
  toInt64,
  least_ as least,
  greatest_ as greatest,
  // Date/time
  toStartOfInterval,
  intervalSub,
  formatDateTime,
  // Conditional
  if_,
  multiIf,
  coalesce,
  nullIf,
  // Array
  arrayOf,
  arrayStringConcat,
  arrayFilter,
  // Map
  mapContains,
  mapGet,
  mapLiteral,
  // JSON
  toJSONString,
} from "./functions"

// Params
export { param, type ParamMarker } from "./param"

// Query builder
export {
  type CHQuery,
  type ColumnAccessor,
  type JoinedColumnAccessor,
  type JoinOnCallback,
  type InferOutput,
  type InferQueryOutput,
  from,
  fromQuery,
} from "./query"

// Compilation
export { compileCH as compile, compileUnion, type CompiledQuery, QueryBuilderError } from "./compile"

// Union
export { unionAll, type CHUnionQuery, type InferUnionOutput } from "./union"

// Tables
export * as tables from "./tables"

// Queries — Traces
export {
  tracesTimeseriesQuery,
  tracesBreakdownQuery,
  tracesListQuery,
  tracesRootListQuery,
  type TracesTimeseriesOpts,
  type TracesBreakdownOpts,
  type TracesListOpts,
  type TracesRootListOpts,
  type TracesTimeseriesOutput,
  type TracesBreakdownOutput,
  type TracesListOutput,
  type TracesRootListOutput,
} from "./queries/traces"

// Queries — Attribute Keys & Values
export {
  attributeKeysQuery,
  spanAttributeValuesQuery,
  resourceAttributeValuesQuery,
  type AttributeKeysQueryOpts,
  type AttributeKeysOutput,
  type AttributeValuesOpts,
  type AttributeValuesOutput,
} from "./queries/attribute-keys"

// Queries — Metrics
export {
  metricsTimeseriesQuery,
  metricsTimeseriesRateQuery,
  metricsBreakdownQuery,
  type MetricsTimeseriesOpts,
  type MetricsTimeseriesOutput,
  type MetricsRateTimeseriesOpts,
  type MetricsRateTimeseriesOutput,
  type MetricsBreakdownOpts,
  type MetricsBreakdownOutput,
  listMetricsQuery,
  metricsSummaryQuery,
  type ListMetricsOpts,
  type ListMetricsOutput,
  type MetricsSummaryOpts,
  type MetricsSummaryOutput,
} from "./queries/metrics"

// Queries — Logs
export {
  logsTimeseriesQuery,
  logsBreakdownQuery,
  logsCountQuery,
  logsListQuery,
  logsFacetsQuery,
  errorRateByServiceQuery,
  type LogsTimeseriesOpts,
  type LogsTimeseriesOutput,
  type LogsBreakdownOpts,
  type LogsBreakdownOutput,
  type LogsCountOutput,
  type LogsListOpts,
  type LogsListOutput,
  type LogsFacetsOutput,
  type ErrorRateByServiceOutput,
} from "./queries/logs"

// Queries — Services
export {
  serviceOverviewQuery,
  serviceReleasesTimelineQuery,
  serviceApdexTimeseriesQuery,
  serviceUsageQuery,
  servicesFacetsQuery,
  type ServiceOverviewOpts,
  type ServiceOverviewOutput,
  type ServiceReleasesTimelineOpts,
  type ServiceReleasesTimelineOutput,
  type ServiceApdexTimeseriesOpts,
  type ServiceApdexTimeseriesOutput,
  type ServiceUsageOpts,
  type ServiceUsageOutput,
  type ServicesFacetsOutput,
} from "./queries/services"

// Queries — Errors
export {
  errorFingerprint,
  errorsByTypeQuery,
  errorsTimeseriesQuery,
  spanHierarchyQuery,
  tracesDurationStatsQuery,
  tracesFacetsQuery,
  errorsFacetsQuery,
  errorsSummaryQuery,
  errorDetailTracesQuery,
  errorIssuesQuery,
  errorIssueTimeseriesQuery,
  errorIssueSampleTracesQuery,
  type ErrorsByTypeOpts,
  type ErrorsByTypeOutput,
  type ErrorsTimeseriesOpts,
  type ErrorsTimeseriesOutput,
  type SpanHierarchyOpts,
  type SpanHierarchyOutput,
  type TracesDurationStatsOpts,
  type TracesDurationStatsOutput,
  type TracesFacetsOpts,
  type TracesFacetsOutput,
  type ErrorsFacetsOpts,
  type ErrorsFacetsOutput,
  type ErrorsSummaryOpts,
  type ErrorsSummaryOutput,
  type ErrorDetailTracesOpts,
  type ErrorDetailTracesOutput,
  type ErrorIssuesOpts,
  type ErrorIssuesOutput,
  type ErrorIssueTimeseriesOutput,
  type ErrorIssueSampleTracesOutput,
} from "./queries/errors"

// Queries — Service Map
export {
  serviceDependenciesSQL,
  type ServiceDependenciesOpts,
  type ServiceDependenciesOutput,
} from "./queries/service-map"

// Queries — Alerts: removed. Alert evaluation now reuses the dashboard
// timeseries queries (tracesTimeseriesQuery / logsTimeseriesQuery /
// metricsTimeseriesQuery) so dashboards and alerts share the same grouping
// and filter semantics. See QueryEngineService.makeQueryEngineEvaluate.

// Queries — Alert Checks (historical rule evaluations)
export {
  listRuleChecksQuery,
  type ListRuleChecksOpts,
  type ListRuleChecksOutput,
} from "./queries/alert-checks"
