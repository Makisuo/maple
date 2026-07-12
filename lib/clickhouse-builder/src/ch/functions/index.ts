// ---------------------------------------------------------------------------
// ClickHouse Functions — Barrel Re-export
// ---------------------------------------------------------------------------

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
	sumIf,
	avgIf,
	maxIf,
	groupUniqArray,
	argMaxMerge,
} from "./aggregate"

export {
	toString_,
	positionCaseInsensitive,
	position_,
	left_,
	length_,
	lower_,
	replaceOne,
	extract_,
	concat,
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
	toHour,
	toUnixTimestamp,
	toUnixTimestamp64Nano,
	intervalSub,
	formatDateTime,
	toDateTime,
} from "./date-time"

export { if_, multiIf, coalesce, nullIf } from "./conditional"

export { arrayOf, arrayStringConcat, arrayFilter, arrayJoin } from "./array"

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
