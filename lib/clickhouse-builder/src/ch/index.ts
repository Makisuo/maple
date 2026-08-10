// ClickHouse Query DSL — Public API

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
	outerRef,
	// Reference an output alias (a GROUP BY key or aggregate) that isn't on the
	// column accessor — the usual way to write a `having()` body.
	dynamicColumn,
} from "./expr"

// Subquery conditions. These accept a `CHQuery` as well as raw SQL, so they
// supersede the string-only `exists`/`inSubquery` still exported from `./expr`
// for direct subpath importers.
export { type Subquery, exists, inSubquery, notInSubquery } from "./subquery"

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
	uniqIf,
	sumIf,
	avgIf,
	maxIf,
	minIf,
	groupUniqArray,
	groupUniqArrayIf,
	argMin,
	argMax,
	argMaxMerge,
	// String
	toString_ as toString,
	positionCaseInsensitive,
	position_ as position,
	left_ as left,
	length_ as length,
	lower_,
	domain_,
	path_,
	cutQueryString,
	replaceOne,
	extract_ as extract,
	match_ as match,
	matchCond,
	concat,
	hasToken,
	hasAllTokens,
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
	has,
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
	type RawSqlReason,
	type CompiledQuery,
	type CompiledQueryRowSchema,
	type TenantScope,
	QueryBuilderError,
	CompiledQueryDecodeError,
} from "./compile"

// Union
export { unionAll, type CHUnionQuery, type InferUnionOutput } from "./union"
