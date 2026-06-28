// The six raw telemetry tables that Maple archives to Parquet. Aggregation and
// materialized-view tables are intentionally excluded: they are rebuildable from
// raw telemetry and would balloon archive volume without preserving any fact the
// raw tables do not already carry.
//
// Each signal names its event-time column, which drives the fixed half-open
// UTC-day range predicate (`>= start AND < end`). `logs` uses `TimestampTime`
// (the partition/TTL driver) for partition alignment while still bounding on
// `Timestamp` for nanosecond precision when needed; here we partition and range
// on the same column the store TTLs on, so an archived day is exactly the set of
// rows ClickHouse would have retained for that day.

export type ArchiveSignalName =
	| "logs"
	| "traces"
	| "metrics_sum"
	| "metrics_gauge"
	| "metrics_histogram"
	| "metrics_exponential_histogram"

export interface ArchiveSignal {
	/** The raw table name; also the on-disk signal directory name. */
	readonly name: ArchiveSignalName
	/** Event-time column used for the UTC-day range predicate. */
	readonly eventTimeColumn: string
}

export const ARCHIVE_SIGNALS: ReadonlyArray<ArchiveSignal> = [
	{ name: "logs", eventTimeColumn: "TimestampTime" },
	{ name: "traces", eventTimeColumn: "Timestamp" },
	{ name: "metrics_sum", eventTimeColumn: "TimeUnix" },
	{ name: "metrics_gauge", eventTimeColumn: "TimeUnix" },
	{ name: "metrics_histogram", eventTimeColumn: "TimeUnix" },
	{ name: "metrics_exponential_histogram", eventTimeColumn: "TimeUnix" },
]

export const isArchiveSignalName = (value: string): value is ArchiveSignalName =>
	ARCHIVE_SIGNALS.some((s) => s.name === value)

export const archiveSignal = (name: string): ArchiveSignal => {
	const signal = ARCHIVE_SIGNALS.find((s) => s.name === name)
	if (!signal) throw new Error(`unknown archive signal: ${name}`)
	return signal
}
