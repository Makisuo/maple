// ---------------------------------------------------------------------------
// ClickHouse Query DSL — Public API
//
// Usage:
//   import * as CH from "@maple/query-engine/ch"
//
//   const q = CH.from(CH.tables.Traces)
//     .select($ => ({
//       bucket: CH.toStartOfInterval($.Timestamp, 60),
//       count: CH.count(),
//     }))
//     .where($ => [ $.OrgId.eq(CH.param.string("orgId")) ])
//     .groupBy("bucket")
//     .format("JSON")
//
//   const sql = CH.compile(q, { orgId: "org_123", ... })
// ---------------------------------------------------------------------------

// Types
export {
  type CHType,
  type CHString,
  type CHUInt8,
  type CHUInt16,
  type CHUInt32,
  type CHUInt64,
  type CHInt32,
  type CHFloat64,
  type CHDateTime,
  type CHDateTime64,
  type CHBool,
  type CHMap,
  type CHArray,
  type CHNullable,
  type InferTS,
  type ColumnDefs,
  string,
  uint8,
  uint16,
  uint32,
  uint64,
  int32,
  float64,
  dateTime,
  dateTime64,
  bool,
  map,
  array,
  nullable,
} from "./types"

// Table
export { type Table, table } from "./table"

// Expressions
export {
  type Expr,
  type ColumnRef,
  type Condition,
  // Literals
  lit,
  // Aggregates
  count,
  countIf,
  avg,
  sum,
  min_ as min,
  max_ as max,
  quantile,
  any_,
  anyIf,
  // ClickHouse functions
  toStartOfInterval,
  if_,
  coalesce,
  nullIf,
  toString_ as toString,
  toFloat64OrZero,
  toUInt16OrZero,
  positionCaseInsensitive,
  mapContains,
  arrayStringConcat,
  arrayFilter,
  extract_ as extract,
  inList,
  // Raw escape hatches
  rawExpr,
  rawCond,
  // Conditional helpers
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

// Queries
export {
  tracesTimeseriesQuery,
  tracesBreakdownQuery,
  tracesListQuery,
  type TracesTimeseriesOpts,
  type TracesBreakdownOpts,
  type TracesListOpts,
  type TracesTimeseriesOutput,
  type TracesBreakdownOutput,
  type TracesListOutput,
} from "./queries/traces"
