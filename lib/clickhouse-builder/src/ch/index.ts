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
	inExprList,
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
	avgIf,
	maxIf,
	groupUniqArray,
	argMaxMerge,
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
	toFloat64,
	toUInt16OrZero,
	toUInt64,
	toInt64,
	least_ as least,
	greatest_ as greatest,
	cityHash64,
	// Date/time
	toStartOfInterval,
	toStartOfHour,
	toUnixTimestamp,
	toUnixTimestamp64Nano,
	intervalSub,
	formatDateTime,
	toDateTime,
	// Conditional
	if_,
	multiIf,
	coalesce,
	nullIf,
	// Array
	arrayOf,
	arrayStringConcat,
	arrayFilter,
	arrayJoin,
	// Map
	mapContains,
	mapGet,
	mapKeys,
	mapValues,
	mapLiteral,
	// JSON
	toJSONString,
	// Window
	currentRow,
	unboundedPreceding,
	unboundedFollowing,
	preceding,
	following,
	rowsBetween,
	windowSpec,
	over,
	lagInFrame,
	type CompiledWindowSpec,
	type WindowFrameBound,
	type WindowOrderDirection,
	type WindowRowsFrame,
	type WindowSpec,
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
	fromUnion,
} from "./query"

// Compilation
export {
	compileCH,
	compileCH as compile,
	compileUnion,
	unsafeCompiledQuery,
	type CompiledQuery,
	type CompiledQueryRowSchema,
	QueryBuilderError,
	CompiledQueryDecodeError,
} from "./compile"

// Union
export { unionAll, type CHUnionQuery, type InferUnionOutput } from "./union"
