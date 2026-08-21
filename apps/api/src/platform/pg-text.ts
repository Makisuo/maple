import { Schema, SchemaGetter } from "effect"

/**
 * Bound on a warehouse-sourced string bound for a Postgres `text` column.
 *
 * A database error that quotes its statement and params is a message that
 * grows by one quoted statement every time it is re-reported; the cap keeps
 * that from compounding.
 */
export const PG_TEXT_MAX_CHARS = 4_000

const sanitize = (maxChars: number) => (value: string) => {
	const clean = value.replaceAll("\u0000", "")
	if (clean.length <= maxChars) return clean
	return `${clean.slice(0, maxChars)}…[truncated ${clean.length - maxChars} chars]`
}

/**
 * Codec from a warehouse string to one Postgres `text` will accept.
 *
 * ClickHouse `String` is bytes and stores anything; Postgres `text` rejects a
 * NUL with `invalid byte sequence for encoding "UTF8": 0x00` (SQLSTATE 22021).
 * The error tick learned this the hard way: a CLI crash message carried raw
 * bytes from a corrupted chDB metadata file, the candidate upsert failed, the
 * failure (whose message quoted the same params) was reported as an error of
 * its own, and the next tick failed on *that* — once a minute for a day.
 *
 * Decode strips NUL and caps at `maxChars`; encode is the identity, since a
 * value that came out of Postgres is already within bounds. The decode is
 * total, so `Schema.decodeSync` cannot throw.
 */
export const PgText = (maxChars: number = PG_TEXT_MAX_CHARS) =>
	Schema.String.pipe(
		Schema.decodeTo(Schema.String, {
			decode: SchemaGetter.transform(sanitize(maxChars)),
			encode: SchemaGetter.passthrough(),
		}),
	).annotate({ identifier: "@maple/PgText", description: "Postgres-safe text: NUL-free, length-capped" })

/** The default-capped codec, ready to compose into row schemas. */
export const PgTextDefault = PgText()

/** Decode one warehouse string into Postgres-safe text. */
export const toPgText = Schema.decodeSync(PgTextDefault)
