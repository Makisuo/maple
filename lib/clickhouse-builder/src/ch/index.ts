// ClickHouse Query DSL — Public API

// Types
export {
	type CHType,
	type CHString,
	type CHUInt8,
	type CHUInt16,
	type CHUInt32,
	type CHInt32,
	type CHInt64,
	type CHBool,
	type CHUInt64,
	type CHFloat64,
	type CHDateTime,
	type CHDateTimeString,
	type CHDateTime64String,
	type CHDateTime64,
	type CHMap,
	type CHArray,
	type CHNullable,
	type InferTS,
	type InferEncoded,
	type ColumnDefs,
	type OutputToColumnDefs,
	type NullableColumnDefs,
	string,
	uint8,
	uint16,
	uint32,
	bool,
	uint64,
	int32,
	int64,
	float64,
	aggregateState,
	untyped,
	dateTime,
	dateTime64,
	dateTimeString,
	dateTime64String,
	map,
	array,
	nullable,
	custom,
} from "./types"

// Table
export { type Table, type TableOptions, table } from "./table"

// Core expression primitives
export {
	type Expr,
	type ColumnRef,
	type Condition,
	// In the signature of every comparison method and of `ColumnRef.get`, so a
	// consumer writing a generic helper over `Expr` needs them at the root.
	type Comparable,
	type MapValueOf,
	lit,
	rawExpr,
	untypedExpr,
	rawCond,
	when,
	whenTrue,
	inList,
	inExprList,
	notInList,
	// Negating a condition is table stakes; it was `/expr`-only.
	not,
	outerRef,
	// Reference an output alias (a GROUP BY key or aggregate) that isn't on the
	// column accessor — the usual way to write a `having()` body.
	dynamicColumn,
} from "./expr"

// Subquery conditions. These accept a `CHQuery` as well as raw SQL, so they
// supersede the string-only `exists`/`inSubquery` still exported from `./expr`
// for direct subpath importers.
export {
	type Subquery,
	exists,
	inSubquery,
	notInSubquery,
	// Splice an inner query's SQL where the builder has no syntax — compiled by
	// the outer `compile`, so its failures land in the outer error channel.
	subqueryExpr,
	subqueryCond,
	untypedSubqueryExpr,
} from "./subquery"

// Function factories (for extensibility by package consumers)
export {
	arrayOfArg,
	compileFnCall,
	compileFnCallCond,
	compileTypedFnCall,
	defineCondFn,
	defineFn,
	defineUntypedFn,
	elementOf,
	elementSchema,
	firstTyped,
	type FnResult,
	makeCond,
	makeExpr,
	makeUntypedExpr,
	sameAs,
	schemaOf,
	schemaOfAny,
} from "./define-fn"

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
	groupUniqArrayArray,
	groupUniqArrayIf,
	argMin,
	argMax,
	argMaxMerge,
	windowFunnel,
	sequenceMatch,
	type WindowFunnelMode,
	// String
	toString_ as toString,
	positionCaseInsensitive,
	position_ as position,
	left_ as left,
	length_ as length,
	lower_ as lower,
	domain_ as domain,
	hex,
	path_ as path,
	cutQueryString,
	replaceOne,
	extract_ as extract,
	match_ as match,
	matchCond,
	concat,
	hasToken,
	hasAllTokens,
	// Numeric
	round_ as round,
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
	toStartOfMinute,
	toHour,
	toUnixTimestamp,
	toUnixTimestamp64Nano,
	intervalAdd,
	intervalSub,
	formatDateTime,
	toDateTime,
	// Conditional
	if_,
	multiIf,
	coalesce,
	nullIf,
	ifNotFinite,
	// Array
	arrayOf,
	arrayStringConcat,
	arrayFilter,
	arrayDistinct,
	arrayElement,
	arrayJoin,
	arrayPushFront,
	arrayReverseSort,
	arraySort,
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
export { param, paramPlaceholder, type ParamKind, type ParamMarker } from "./param"

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
	// `compileCH` / `compileCHUnsafe` are the internal names; the public API is
	// four, not six — `compile`/`compileUnion` and their `Unsafe` counterparts.
	compileCH as compile,
	compileCHUnsafe as compileUnsafe,
	compileUnion,
	compileUnionUnsafe,
	rawCompiledQuery,
	type CompiledQuery,
	type CompiledQueryInput,
	type CompiledQueryRowSchema,
	type TenantScope,
	CompiledQueryDecodeError,
	CompiledQueryEncodeError,
} from "./compile"

// Failures vs defects — the rule the two classes encode is on `QueryBuilderError`.
export { QueryBuilderError, QueryBuilderDefect } from "./errors"

// Union
export { unionAll, type CHUnionQuery, type InferUnionOutput } from "./union"
