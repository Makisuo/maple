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
  toStartOfInterval,
  if_,
  inList,
  rawExpr,
  rawCond,
  when,
  whenTrue,
} from "./expr"

// Params
export { param, type ParamMarker } from "./param"

// Query builder
export {
  type CHQuery,
  type ColumnAccessor,
  type InferOutput,
  from,
} from "./query"

// Compilation
export { compileCH as compile, type CompiledQuery } from "./compile"

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

// Queries — Attribute Keys
export {
  attributeKeysQuery,
  type AttributeKeysQueryOpts,
  type AttributeKeysOutput,
} from "./queries/attribute-keys"

// Queries — Metrics
export {
  metricsTimeseriesQuery,
  metricsTimeseriesRateSQL,
  metricsBreakdownQuery,
  type MetricsTimeseriesOpts,
  type MetricsTimeseriesOutput,
  type MetricsRateTimeseriesOpts,
  type MetricsRateTimeseriesOutput,
  type MetricsBreakdownOpts,
  type MetricsBreakdownOutput,
} from "./queries/metrics"
