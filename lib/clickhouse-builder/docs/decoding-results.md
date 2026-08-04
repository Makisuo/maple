# Decoding results

The builder does not execute anything. You run `compiled.sql` with your own client and hand the
rows back:

```ts
import { Effect } from "effect"

const rows = await Effect.runPromise(compiled.decodeRows(await runOnClickHouse(compiled.sql)))
```

## Declare a `rowSchema`

Pass an Effect `Schema` at compile time and `decodeRows` validates every row against it:

```ts
import { Schema } from "effect"

const compiled = CH.compile(query, params, {
	rowSchema: Schema.Struct({
		name: Schema.String,
		count: Schema.Union([Schema.Finite, Schema.FiniteFromString]),
	}),
})

await Effect.runPromise(compiled.decodeRows([{ name: "checkout", count: "42" }]))
// [{ name: "checkout", count: 42 }]
```

Note the `count` schema: some backends return 64-bit integers as JSON **strings** and others as
numbers. Accepting both — and letting the schema coerce — is what stops that difference from
becoming a runtime bug. This is the exact class of drift a plain cast used to hide, which is
why there is no `castRows`.

_(Backed by `docs/decoding-results.md > decodeRows validates every row`.)_

## Without a schema, nothing is checked

```ts
const compiled = CH.compile(query, params) // no rowSchema

compiled.rowSchemaDeclared // false
await Effect.runPromise(compiled.decodeRows([{ name: 42 }]))
// [{ name: 42 }] — passes straight through, despite `name` being typed as string
```

`decodeRows` degrades to an identity pass-through. The static type still claims `Output`, so
the mismatch is invisible until something downstream trips over it. `rowSchemaDeclared` exists
so a caller — or a lint over your query catalog — can tell the two apart.

Declare a schema for anything whose shape you do not fully control.

_(Backed by `docs/decoding-results.md > Without a rowSchema decoding is a pass-through`.)_

## `decodeFirstRow`

For point lookups, returning `Option<Output>` rather than making you hand-roll `rows[0] ?? null`:

```ts
const first = await Effect.runPromise(compiled.decodeFirstRow(rows))
Option.getOrNull(first) // Output | null
```

An empty input yields `Option.none()`.

_(Backed by `docs/decoding-results.md > decodeFirstRow returns an Option`.)_

## Decode failures

Both decoders fail with `CompiledQueryDecodeError`, carrying the index of the offending row:

```ts
const error = await Effect.runPromise(Effect.flip(compiled.decodeRows([{ name: 42, count: 1 }])))

error._tag // "@maple-dev/clickhouse-builder/CompiledQueryDecodeError"
error.rowIndex // 0
error.message // "Compiled query row 0 did not match its declared output schema"
error.cause // the underlying Schema parse error
```

It is an Effect `Schema.TaggedErrorClass`, so `Effect.catchTag` works on it directly. Decoding
stops at the first bad row rather than accumulating.

_(Backed by `docs/decoding-results.md > A bad row fails with CompiledQueryDecodeError`.)_

## Choosing schema types

- **64-bit integers** — accept both wire shapes, as above. A `UInt64` above `2^53` cannot
  survive as a JavaScript number at all; have such columns emitted as strings
  (`toString(...)`) in the SELECT and decode them as `Schema.String`.
- **`DateTime` columns** — arrive as strings; decode as `Schema.String` unless you genuinely
  want to parse them.
- **`leftJoin` columns** — nullable on the SQL side, so pair them with `Schema.NullOr`.
