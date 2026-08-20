// Decoding rows out of chDB's JSONEachRow output.
//
// Nine copies of a `split("\n") … JSON.parse(line) as A` helper used to live
// across the migration coordinator, the physical-schema inspector, and every
// versioned edge — each one ending in an unchecked cast at the point where an
// external process hands us bytes. The shape is declared once here and the
// rows are decoded, not asserted.
import { Schema } from "effect"

/**
 * Decode chDB JSONEachRow output.
 *
 * A row that does not match the schema is a query returning something other
 * than what the caller asked for, which is a bug in the SQL rather than data to
 * be tolerated — so this throws instead of skipping the row.
 */
export const decodeJsonEachRow = <S extends Schema.Codec<unknown, unknown, never, never>>(
	rowSchema: S,
): ((value: string) => Array<S["Type"]>) => {
	const decodeRow = Schema.decodeUnknownSync(rowSchema)
	return (value) =>
		value
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.map((line) => decodeRow(JSON.parse(line)))
}

/**
 * `sum(rows)` per table, as returned by the raw-telemetry inventory query.
 *
 * The count is `toString()`-wrapped in SQL because it is a ClickHouse UInt64:
 * above 2^53 a JS number silently loses the low bits, and these values are
 * compared for exact equality when a migration verifies that no row was lost.
 */
export const TableRowCountSchema = Schema.Struct({
	table: Schema.String,
	rowCount: Schema.String.check(Schema.isPattern(/^\d+$/)),
})

export const decodeTableRowCounts = decodeJsonEachRow(TableRowCountSchema)

/** A single `toString(count())`-style scalar, for the same UInt64 reason. */
export const RowCountSchema = Schema.Struct({
	rowCount: Schema.String.check(Schema.isPattern(/^\d+$/)),
})

export const decodeRowCounts = decodeJsonEachRow(RowCountSchema)

/**
 * Rows whose columns are not known ahead of time.
 *
 * The v0 -> v1 raw replay copies whatever columns the source table happens to
 * have, so there is no field list to declare. Requiring each line to be a JSON
 * object is the only claim that can honestly be made about it, and it is still
 * a claim worth making: a bare scalar or array here means the query returned
 * something other than rows.
 */
const OpaqueRowSchema = Schema.Record(Schema.String, Schema.Unknown)

export const decodeJsonObjectRows = decodeJsonEachRow(OpaqueRowSchema)
