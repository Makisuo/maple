// Shared ClickHouse row-schema codecs
//
// ClickHouse's `FORMAT JSON` serializes 64-bit integers (`UInt64`/`Int64`, the
// result of `count()`, `sum()`, `uniqExact()`, …) as JSON *strings*, whereas
// managed Tinybird returns them as numbers. A BYO-ClickHouse org reads its own
// ClickHouse, so its aggregate columns arrive as strings.
//
// `CHNumber` decodes *either* representation to a finite number, so BYO-CH and
// managed orgs behave identically. Attach it (via a `Schema.Struct` row schema)
// to any compiled query whose numeric outputs flow into a runtime `Schema.Number`
// — otherwise the string trips a `ParseError` the moment it hits a `Schema.Class`
// constructor or an HTTP response encode.

import { Schema, SchemaGetter } from "effect"

/**
 * Decodes a ClickHouse-quoted numeric string (`"2"`) or a native JSON number
 * (`2`) to a finite `number`. Rejects `NaN`/`Infinity`.
 */
export const CHNumber = Schema.Union([Schema.Finite, Schema.FiniteFromString])

/**
 * The same, for a column ClickHouse can return as `NULL`, decoded as `0`.
 *
 * The shape is `sum(a) / nullIf(sum(b), 0)` — an average written to yield NULL
 * rather than divide by zero. The analyzer types that `Nullable(Float64)`, and
 * a plain `CHNumber` rejects the null it was written to produce, failing the
 * whole request on the first row with no calls in the window.
 *
 * Zero rather than `null` because that is what every consumer already does with
 * it — `toNumber(value) = Number(value ?? 0)` in the query-engine routes, and
 * the same coercion in the MCP tools. Decoding it here means one place decides,
 * instead of each caller re-deciding and the type saying `number` either way.
 */
export const CHNumberOrZero: Schema.Codec<number, number | string | null> = Schema.NullOr(CHNumber).pipe(
	Schema.decodeTo(Schema.Number, {
		decode: SchemaGetter.transform((value: number | null) => value ?? 0),
		encode: SchemaGetter.transform((value: number) => value),
	}),
)
