import { makeExpr } from "../expr"
import { raw, str, compile } from "../../sql/sql-fragment"
import type { Expr } from "../expr"

// Date/time functions (handwritten — custom INTERVAL syntax)

export function toStartOfInterval(col: Expr<string>, seconds: number | Expr<number>): Expr<string> {
	const secStr =
		typeof seconds === "number"
			? String(Math.round(seconds))
			: compile((seconds as Expr<number>).toFragment())
	return makeExpr<string>(raw(`toStartOfInterval(${compile(col.toFragment())}, INTERVAL ${secStr} SECOND)`))
}

/**
 * `toStartOfHour(expr)` — floor a DateTime to its hour boundary. Equivalent to
 * `toStartOfInterval(col, 3600)` but kept as a distinct function so queries
 * that bucket on natural hours stay legible (the resolutions rollup, the
 * service-map edge rollup, and the dependencies tab all read from
 * `*_hourly` tables on this exact boundary).
 */
export function toStartOfHour(col: Expr<string>): Expr<string> {
	return makeExpr<string>(raw(`toStartOfHour(${compile(col.toFragment())})`))
}

/**
 * `toStartOfMinute(expr)` — floor a DateTime to its minute boundary. The
 * minute-grain counterpart of {@link toStartOfHour}, for queries spliced against
 * a `*_minutely` rollup.
 */
export function toStartOfMinute(col: Expr<string>): Expr<string> {
	return makeExpr<string>(raw(`toStartOfMinute(${compile(col.toFragment())})`))
}

/**
 * `toHour(expr)` — extract the hour-of-day (0–23) from a DateTime. Used by the
 * anomaly detector's seasonal-naive baseline to select "matched hours" (same
 * hour-of-day ±1) across the trailing week without storing baselines anywhere.
 */
export function toHour(col: Expr<string>): Expr<number> {
	return makeExpr<number>(raw(`toHour(${compile(col.toFragment())})`))
}

/**
 * `toUnixTimestamp(expr)` — convert a DateTime/DateTime64 to a UInt32 of
 * seconds since epoch. Useful for stable JSON-numeric keys (e.g. the rollup's
 * "have we already sealed this hour" check) without forcing the consumer to
 * parse RFC3339.
 */
export function toUnixTimestamp(col: Expr<string>): Expr<number> {
	return makeExpr<number>(raw(`toUnixTimestamp(${compile(col.toFragment())})`))
}

/**
 * `toUnixTimestamp64Nano(expr)` — convert DateTime64 to a nanosecond epoch.
 * Used for counter-rate delta windows where sub-second scrape spacing matters.
 */
export function toUnixTimestamp64Nano(col: Expr<string>): Expr<number> {
	return makeExpr<number>(raw(`toUnixTimestamp64Nano(${compile(col.toFragment())})`))
}

export function intervalSub(col: Expr<string>, seconds: number | Expr<number>): Expr<string> {
	const secStr =
		typeof seconds === "number"
			? String(Math.round(seconds))
			: compile((seconds as Expr<number>).toFragment())
	return makeExpr<string>(raw(`${compile(col.toFragment())} - INTERVAL ${secStr} SECOND`))
}

/** The other half of {@link intervalSub} — `expr + INTERVAL n SECOND`. */
export function intervalAdd(col: Expr<string>, seconds: number | Expr<number>): Expr<string> {
	const secStr =
		typeof seconds === "number"
			? String(Math.round(seconds))
			: compile((seconds as Expr<number>).toFragment())
	return makeExpr<string>(raw(`${compile(col.toFragment())} + INTERVAL ${secStr} SECOND`))
}

/** `formatDateTime(expr, 'format')` — format a DateTime/DateTime64 as a string. */
export function formatDateTime(col: Expr<string>, format: string): Expr<string> {
	return makeExpr<string>(raw(`formatDateTime(${compile(col.toFragment())}, ${compile(str(format))})`))
}

/**
 * `toDateTime(expr)` — coerce a value to DateTime. Needed when passing a
 * string-typed param into functions (e.g. `toStartOfInterval`) that strictly
 * require a Date/DateTime/DateTime64 argument and won't implicitly parse a
 * string literal.
 */
export function toDateTime(col: Expr<string>): Expr<string> {
	return makeExpr<string>(raw(`toDateTime(${compile(col.toFragment())})`))
}
