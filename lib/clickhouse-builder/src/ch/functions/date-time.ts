import type { DateTime } from "effect"
import { makeExpr } from "../expr"
import { schemaOf } from "../define-fn"
import { raw, str, compile } from "../../sql/sql-fragment"
import type { Expr } from "../expr"
import * as T from "../types"

/**
 * A DateTime-valued expression: a column, a param, or `now()`.
 *
 * Generic over how it decodes so the flavour survives the call — floor a
 * `DateTime.Utc` column and you get a `DateTime.Utc`; floor one declared as
 * `dateTimeString` and you get the string ClickHouse sent.
 */
type DateTimeValue = DateTime.Utc | string
type DateTimeExpr<T extends DateTimeValue = DateTime.Utc> = Expr<T>

/** Keep the input's own decoding; fall back to parsed UTC for an untyped one. */
const sameDateTime = <T extends DateTimeValue>(col: Expr<T>) =>
	(schemaOf<T>(col) ?? T.dateTime.schema) as Parameters<typeof makeExpr<T>>[1]

// Date/time functions (handwritten — custom INTERVAL syntax)

export function toStartOfInterval<T extends DateTimeValue = DateTime.Utc>(
	col: DateTimeExpr<T>,
	seconds: number | Expr<number>,
): DateTimeExpr<T> {
	const secStr =
		typeof seconds === "number"
			? String(Math.round(seconds))
			: compile((seconds as Expr<number>).toFragment())
	return makeExpr(
		raw(`toStartOfInterval(${compile(col.toFragment())}, INTERVAL ${secStr} SECOND)`),
		sameDateTime(col),
	)
}

/**
 * `toStartOfHour(expr)` — floor a DateTime to its hour boundary. Equivalent to
 * `toStartOfInterval(col, 3600)` but kept as a distinct function so queries
 * that bucket on natural hours stay legible (the resolutions rollup, the
 * service-map edge rollup, and the dependencies tab all read from
 * `*_hourly` tables on this exact boundary).
 */
export function toStartOfHour<T extends DateTimeValue = DateTime.Utc>(col: DateTimeExpr<T>): DateTimeExpr<T> {
	return makeExpr(raw(`toStartOfHour(${compile(col.toFragment())})`), sameDateTime(col))
}

/**
 * `toStartOfMinute(expr)` — floor a DateTime to its minute boundary. The
 * minute-grain counterpart of {@link toStartOfHour}, for queries spliced against
 * a `*_minutely` rollup.
 */
export function toStartOfMinute<T extends DateTimeValue = DateTime.Utc>(
	col: DateTimeExpr<T>,
): DateTimeExpr<T> {
	return makeExpr(raw(`toStartOfMinute(${compile(col.toFragment())})`), sameDateTime(col))
}

/**
 * `toHour(expr)` — extract the hour-of-day (0–23) from a DateTime. Used by the
 * anomaly detector's seasonal-naive baseline to select "matched hours" (same
 * hour-of-day ±1) across the trailing week without storing baselines anywhere.
 */
export function toHour(col: DateTimeExpr<DateTimeValue>): Expr<number> {
	return makeExpr(raw(`toHour(${compile(col.toFragment())})`), T.uint8.schema)
}

/**
 * `toUnixTimestamp(expr)` — convert a DateTime/DateTime64 to a UInt32 of
 * seconds since epoch. Useful for stable JSON-numeric keys (e.g. the rollup's
 * "have we already sealed this hour" check) without forcing the consumer to
 * parse RFC3339.
 */
export function toUnixTimestamp(col: DateTimeExpr<DateTimeValue>): Expr<number> {
	return makeExpr(raw(`toUnixTimestamp(${compile(col.toFragment())})`), T.uint32.schema)
}

/**
 * `toUnixTimestamp64Nano(expr)` — convert DateTime64 to a nanosecond epoch.
 * Used for counter-rate delta windows where sub-second scrape spacing matters.
 */
export function toUnixTimestamp64Nano(col: DateTimeExpr<DateTimeValue>): Expr<number> {
	return makeExpr(raw(`toUnixTimestamp64Nano(${compile(col.toFragment())})`), T.uint64.schema)
}

export function intervalSub<T extends DateTimeValue = DateTime.Utc>(
	col: DateTimeExpr<T>,
	seconds: number | Expr<number>,
): DateTimeExpr<T> {
	const secStr =
		typeof seconds === "number"
			? String(Math.round(seconds))
			: compile((seconds as Expr<number>).toFragment())
	return makeExpr(raw(`${compile(col.toFragment())} - INTERVAL ${secStr} SECOND`), sameDateTime(col))
}

/** The other half of {@link intervalSub} — `expr + INTERVAL n SECOND`. */
export function intervalAdd<T extends DateTimeValue = DateTime.Utc>(
	col: DateTimeExpr<T>,
	seconds: number | Expr<number>,
): DateTimeExpr<T> {
	const secStr =
		typeof seconds === "number"
			? String(Math.round(seconds))
			: compile((seconds as Expr<number>).toFragment())
	return makeExpr(raw(`${compile(col.toFragment())} + INTERVAL ${secStr} SECOND`), sameDateTime(col))
}

/** `formatDateTime(expr, 'format')` — format a DateTime/DateTime64 as a string. */
export function formatDateTime(col: DateTimeExpr<DateTimeValue>, format: string): Expr<string> {
	return makeExpr(
		raw(`formatDateTime(${compile(col.toFragment())}, ${compile(str(format))})`),
		T.string.schema,
	)
}

/**
 * `toDateTime(expr)` — coerce a value to DateTime. Needed when passing a
 * string-typed param into functions (e.g. `toStartOfInterval`) that strictly
 * require a Date/DateTime/DateTime64 argument and won't implicitly parse a
 * string literal.
 */
export function toDateTime<T extends DateTimeValue>(col: Expr<T>): DateTimeExpr<T>
export function toDateTime(col: Expr<number>): DateTimeExpr
export function toDateTime(col: Expr<any>): Expr<any> {
	// A coerced value decodes like whatever it was coerced from: a string param
	// wrapped for `toStartOfInterval` is still the string the caller passed.
	return makeExpr(raw(`toDateTime(${compile(col.toFragment())})`), sameDateTime(col))
}
