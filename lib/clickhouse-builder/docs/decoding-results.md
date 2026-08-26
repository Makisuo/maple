# Decoding results

The builder does not execute anything. You run `compiled.sql` with your own client and hand the
rows back:

```ts
import { Effect } from "effect"

const rows = await Effect.runPromise(compiled.decodeRows(await runOnClickHouse(compiled.sql)))
```

## The row schema is derived from the SELECT

Column types *are* Effect schemas — `T.uint64` is "a 64-bit integer as ClickHouse actually sends
it", not a phantom tag. So a query built from typed pieces already knows how its rows decode, and
`compile` folds those schemas into one:

```ts
const compiled = CH.compile(
	CH.from(Events)
		.select(($) => ({ name: $.Name, calls: CH.count() }))
		.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
		.groupBy("name"),
	{ orgId: "org_123" },
)

compiled.rowSchemaSource // "derived"
await Effect.runPromise(compiled.decodeRows([{ name: "checkout", calls: "42" }]))
// [{ name: "checkout", calls: 42 }]
```

Note `calls`. ClickHouse's `FORMAT JSON` quotes 64-bit integers, Tinybird does not, and a gateway
that refuses `output_format_json_quote_64bit_integers=0` quotes them whatever you asked for.
`T.uint64` models that once, so nobody rediscovers it as a `ParseError` in production. This is the
exact class of drift a plain cast used to hide, which is why there is no `castRows`.

## When there is nothing to derive from

Derivation is all-or-nothing per query. One selected expression the builder cannot type — a
`rawExpr`, a `dynamicColumn`, a `defineFn` that never declared its result — and there is no row
schema at all:

```ts
const compiled = CH.compile(
	CH.from(Events).select(($) => ({ name: $.Name, odd: CH.rawExpr("anyLast(Whatever)") })),
	params,
)

compiled.rowSchemaSource // "none"
await Effect.runPromise(compiled.decodeRows([{ name: 42, odd: 1 }]))
// [{ name: 42, odd: 1 }] — passes straight through
```

Inventing a permissive schema for that one field would hand back something that *looks* validated
and is not, so the query keeps its honest answer instead. Close the gap by typing the escape
hatch — `CH.rawExpr("anyLast(Whatever)", T.string)`, `CH.defineFn("myFn", T.uint64)` — or by
declaring the whole schema yourself.

## Declaring one anyway

A declared `rowSchema` wins over the derived one, and it can do something derivation cannot:
**narrow**.

```ts
const compiled = CH.compile(query, params, {
	rowSchema: Schema.Struct({
		name: Schema.String,
		status: Schema.Literals(["ok", "error"]), // narrower than the String column
	}),
})

compiled.rowSchemaSource // "declared"
```

The declared type must still be assignable to what the builder inferred, so a schema can sharpen
the row but never contradict it.

_(Backed by `docs/decoding-results.md > The row schema is derived from the SELECT`,
`> An untyped expression leaves the query undecoded`.)_

`rowSchemaDeclared` remains as the cheap "does this decode anything at all" check —
`rowSchemaSource !== "none"` — for a lint over your query catalog.

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

It is an Effect `Schema.TaggedError`, so `Effect.catchTag` works on it directly. Decoding
stops at the first bad row rather than accumulating.

_(Backed by `docs/decoding-results.md > A bad row fails with CompiledQueryDecodeError`.)_

## Choosing schema types

Only relevant when you declare one by hand; the column types already handle these.

- **64-bit integers** — accept both wire shapes. A `UInt64` above `2^53` cannot survive as a
  JavaScript number at all; have such columns emitted as strings (`toString(...)`) in the SELECT
  and declare them `T.string`.
- **`DateTime` columns** — `T.dateTime` parses them as UTC; `T.dateTimeString` leaves them as
  sent. See [Tables and column types](./tables-and-types.md#column-types).
- **`leftJoin` columns** — nullable on the SQL side, so pair them with `Schema.NullOr`.
