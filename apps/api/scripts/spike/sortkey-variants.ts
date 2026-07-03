// ---------------------------------------------------------------------------
// spike/sortkey-variants.ts — shadow-table definitions for the sort-key spike
//
// Phase 3 of the ClickStack work: measure whether a time-bucketed primary key
// activates `optimize_read_in_order` for `ORDER BY <ts> DESC LIMIT N` list
// queries (which today use a two-stage cutoff workaround because the sort key
// is `(OrgId, ServiceName, …)`), without regressing service-scoped reads,
// attribute-bloom pruning, or compression.
//
// This is measurement scaffolding, NOT a production change: it builds throwaway
// shadow tables with candidate sort keys, backfills a bounded window of one
// org, and hands off to the `bench suite --table-map` A/B harness. Everything
// here is a pure SQL-string builder (no IO, no deps) so it's unit-testable and
// runnable with bare `bun`.
// ---------------------------------------------------------------------------

export interface SortKeyVariant {
	/** Shadow table name, e.g. `traces_t2`. */
	readonly name: string
	/** Production source table the shadow copies from and backfills out of. */
	readonly base: string
	/** Human-readable description of what this sort key trades off. */
	readonly label: string
	/** PARTITION BY expression (kept identical to the base table). */
	readonly partitionBy: string
	/** Candidate ORDER BY (the thing under test). */
	readonly orderBy: string
	/** Column used to window the backfill (Timestamp for traces, TimestampTime for logs). */
	readonly tsColumn: string
}

// Traces base: PARTITION BY toDate(Timestamp),
//              ORDER BY (OrgId, ServiceName, SpanName, toDateTime(Timestamp)).
export const TRACES_VARIANTS: readonly SortKeyVariant[] = [
	{
		name: "traces_t1",
		base: "traces",
		label: "control — current key, freshly rebuilt (compare like-aged, not vs the aged prod table)",
		partitionBy: "toDate(Timestamp)",
		orderBy: "(OrgId, ServiceName, SpanName, toDateTime(Timestamp))",
		tsColumn: "Timestamp",
	},
	{
		name: "traces_t2",
		base: "traces",
		label: "5-min time bucket + service locality (OrgId stays first for tenant scoping)",
		partitionBy: "toDate(Timestamp)",
		orderBy: "(OrgId, toStartOfFiveMinutes(toDateTime(Timestamp)), ServiceName, toDateTime(Timestamp))",
		tsColumn: "Timestamp",
	},
	{
		name: "traces_t3",
		base: "traces",
		label: "pure time-first (max read_in_order, no service locality) — the upper bound",
		partitionBy: "toDate(Timestamp)",
		orderBy: "(OrgId, toDateTime(Timestamp))",
		tsColumn: "Timestamp",
	},
]

// Logs base: PARTITION BY toDate(TimestampTime),
//            ORDER BY (OrgId, ServiceName, TimestampTime, Timestamp).
export const LOGS_VARIANTS: readonly SortKeyVariant[] = [
	{
		name: "logs_l1",
		base: "logs",
		label: "control — current key",
		partitionBy: "toDate(TimestampTime)",
		orderBy: "(OrgId, ServiceName, TimestampTime, Timestamp)",
		tsColumn: "TimestampTime",
	},
	{
		name: "logs_l2",
		base: "logs",
		label: "5-min time bucket + service locality",
		partitionBy: "toDate(TimestampTime)",
		orderBy: "(OrgId, toStartOfFiveMinutes(TimestampTime), ServiceName, Timestamp)",
		tsColumn: "TimestampTime",
	},
	{
		name: "logs_l3",
		base: "logs",
		label: "pure time-first — the upper bound (also informs the TimestampTime-elimination question)",
		partitionBy: "toDate(TimestampTime)",
		orderBy: "(OrgId, TimestampTime, Timestamp)",
		tsColumn: "TimestampTime",
	},
]

export const ALL_VARIANTS: readonly SortKeyVariant[] = [...TRACES_VARIANTS, ...LOGS_VARIANTS]

/** Single-quote-escape a string literal for inline SQL (org ids are trusted internal ids, but be safe). */
const lit = (s: string): string => `'${s.replace(/'/g, "\\'")}'`

/**
 * `CREATE TABLE <shadow> AS <base>` copies the full column structure AND skip
 * indexes from the base, so we only override the engine clause to swap the sort
 * key. No TTL — shadow tables are throwaway; drop them after the spike.
 */
export function shadowTableDDL(v: SortKeyVariant): string {
	return (
		`CREATE TABLE IF NOT EXISTS ${v.name} AS ${v.base}\n` +
		`ENGINE = MergeTree\n` +
		`PARTITION BY ${v.partitionBy}\n` +
		`ORDER BY ${v.orderBy}`
	)
}

/**
 * One day's chunk of backfill. `SELECT *` works because the shadow shares the
 * base's exact column list (via `AS`). Windowed on the sort/partition ts column
 * so the apply engine (or a shell loop) can split a wide range into per-day
 * INSERTs — a single INSERT…SELECT over a busy org's week is too heavy.
 */
export function backfillSQL(
	v: SortKeyVariant,
	opts: { orgId: string; startInclusive: string; endExclusive: string },
): string {
	return (
		`INSERT INTO ${v.name}\n` +
		`SELECT * FROM ${v.base}\n` +
		`WHERE OrgId = ${lit(opts.orgId)}\n` +
		`  AND ${v.tsColumn} >= toDateTime(${lit(opts.startInclusive)})\n` +
		`  AND ${v.tsColumn} <  toDateTime(${lit(opts.endExclusive)})`
	)
}

export function dropSQL(v: SortKeyVariant): string {
	return `DROP TABLE IF EXISTS ${v.name}`
}

/**
 * EXPLAIN a `ORDER BY <ts> DESC LIMIT N` list query against a shadow table to
 * see whether `optimize_read_in_order` engaged (look for `ReadFromMergeTree`
 * with a sort description / no separate sorting step). This is the question
 * that decides whether the two-stage cutoff workaround can be deleted.
 */
export function readInOrderProbeSQL(v: SortKeyVariant, opts: { orgId: string; limit?: number }): string {
	const limit = opts.limit ?? 50
	return (
		`EXPLAIN actions = 1, indexes = 1\n` +
		`SELECT * FROM ${v.name}\n` +
		`WHERE OrgId = ${lit(opts.orgId)}\n` +
		`ORDER BY ${v.tsColumn} DESC\n` +
		`LIMIT ${limit}`
	)
}
