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

// Expressions (only re-export what is actually used by queries or consumers)
export {
  type Expr,
  type ColumnRef,
  type Condition,
  lit,
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
  toStartOfInterval,
  intervalSub,
  toJSONString,
  if_,
  concat,
  round_,
  intDiv,
  inList,
  positionCaseInsensitive,
  mapContains,
  mapGet,
  arrayStringConcat,
  arrayFilter,
  extract_ as extract,
  toString_ as toString,
  coalesce,
  nullIf,
  toFloat64OrZero,
  toUInt16OrZero,
  rawExpr,
  rawCond,
  when,
  whenTrue,
  arrayOf,
  mapLiteral,
  toUInt64,
  toInt64,
  multiIf,
  position_ as position,
  left_ as left,
  length_ as length,
  replaceOne,
  least_ as least,
  greatest_ as greatest,
  exists,
  inSubquery,
  outerRef,
} from "./expr"

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
} from "./queries/errors"

// Queries — Service Map
export {
  serviceDependenciesSQL,
  type ServiceDependenciesOpts,
  type ServiceDependenciesOutput,
} from "./queries/service-map"

// Queries — Alerts
export {
  alertTracesAggregateQuery,
  alertTracesAggregateByServiceQuery,
  alertMetricsAggregateQuery,
  alertMetricsAggregateByServiceQuery,
  alertLogsAggregateQuery,
  alertLogsAggregateByServiceQuery,
  type AlertTracesOpts,
  type AlertTracesAggregateOutput,
  type AlertTracesAggregateByServiceOutput,
  type AlertMetricsOpts,
  type AlertMetricsAggregateOutput,
  type AlertMetricsAggregateByServiceOutput,
  type AlertLogsOpts,
  type AlertLogsAggregateOutput,
  type AlertLogsAggregateByServiceOutput,
} from "./queries/alerts"
