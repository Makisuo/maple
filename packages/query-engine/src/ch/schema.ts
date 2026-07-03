// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

import { Schema } from "effect"

/**
 * Decodes a ClickHouse-quoted numeric string (`"2"`) or a native JSON number
 * (`2`) to a finite `number`. Rejects `NaN`/`Infinity`.
 */
export const CHNumber = Schema.Union([Schema.Finite, Schema.FiniteFromString])
