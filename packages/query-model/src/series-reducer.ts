/**
 * How a series of buckets collapses to the single number a consumer needs.
 *
 * Two vocabularies exist and they are NOT merged: widgets persist `"first"`
 * (`reduceToValue.aggregate` on a stat or gauge tile) and alert rules persist
 * `"identity"` (`alert_rules.reducer`). They coincide only on a one-bucket
 * window, so collapsing the literal sets would silently rewrite stored values on
 * both sides.
 *
 * What IS shared is the table below. Both sets are derived from it and the
 * mapping between them is total, so adding a reducer is one edit and a reducer
 * that has no counterpart fails to compile rather than falling through at
 * runtime.
 */
/**
 * Order is user-visible: the widget spelling drives the Aggregate picker, and
 * `"first"` leads because it is the runtime default for an absent aggregate.
 */
const REDUCER_TABLE = [
	{ series: "first", alert: "identity" },
	{ series: "sum", alert: "sum" },
	// Widget-only: there is no alert reducer that counts buckets, because a rule
	// compares a value against a threshold rather than a cardinality.
	{ series: "count", alert: null },
	{ series: "avg", alert: "avg" },
	{ series: "max", alert: "max" },
	{ series: "min", alert: "min" },
] as const satisfies ReadonlyArray<{ series: string; alert: string | null }>

export type SeriesReducer = (typeof REDUCER_TABLE)[number]["series"]
export type AlertReducer = Exclude<(typeof REDUCER_TABLE)[number]["alert"], null>

/** Widget spelling. Ordered so `"first"` leads — it is the runtime default. */
export const SERIES_REDUCERS = REDUCER_TABLE.map((entry) => entry.series) as ReadonlyArray<SeriesReducer>

/** Alert-rule spelling. */
export const ALERT_REDUCERS = REDUCER_TABLE.flatMap((entry) =>
	entry.alert === null ? [] : [entry.alert],
) as ReadonlyArray<AlertReducer>

/** Total by construction: every alert reducer has a series counterpart. */
export const ALERT_REDUCER_TO_SERIES_REDUCER = Object.fromEntries(
	REDUCER_TABLE.flatMap((entry) => (entry.alert === null ? [] : [[entry.alert, entry.series] as const])),
) as Record<AlertReducer, SeriesReducer>

/** Partial in the other direction: `"count"` has no alert spelling. */
export const SERIES_REDUCER_TO_ALERT_REDUCER = Object.fromEntries(
	REDUCER_TABLE.flatMap((entry) => (entry.alert === null ? [] : [[entry.series, entry.alert] as const])),
) as Partial<Record<SeriesReducer, AlertReducer>>
