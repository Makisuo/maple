// ClickHouse Functions — Barrel Re-export

export {
	count,
	countIf,
	avg,
	sum,
	min_,
	max_,
	quantile,
	any_,
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
} from "./aggregate"

export {
	toString_,
	positionCaseInsensitive,
	position_,
	left_,
	length_,
	lower_,
	domain_,
	hex,
	path_,
	cutQueryString,
	replaceOne,
	extract_,
	match_,
	matchCond,
	concat,
	hasToken,
	hasAllTokens,
} from "./string"

export {
	round_,
	intDiv,
	toFloat64OrZero,
	toFloat64,
	toUInt16OrZero,
	toUInt64,
	toInt64,
	least_,
	greatest_,
	cityHash64,
} from "./numeric"

export {
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
} from "./date-time"

export { if_, multiIf, coalesce, nullIf } from "./conditional"

export {
	arrayDistinct,
	arrayElement,
	arrayFilter,
	arrayJoin,
	arrayOf,
	arrayPushFront,
	arrayReverseSort,
	arraySort,
	arrayStringConcat,
	has,
} from "./array"

export { mapContains, mapGet, mapKeys, mapValues, mapLiteral } from "./map"

export { toJSONString } from "./json"

export {
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
} from "./window"
