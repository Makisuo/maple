# Tables and column types

## `table(name, columns)`

```ts
import * as CH from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"

const Events = CH.table("events", {
	OrgId: T.string,
	Name: T.string,
	Timestamp: T.dateTime,
	DurationMs: T.uint64,
	Attributes: T.map(T.string, T.string),
})
```

`name` is emitted verbatim as the FROM target, so it can also name a CTE or a view. The
`columns` record is what every accessor, output type, and join is inferred from.

A table is a plain value — `{ _tag: "Table", name, columns }`. It is never checked against a
live server, so a column that does not exist in ClickHouse will typecheck happily and fail at
query time. Treat the declaration as a contract you keep in sync with your migrations.

## Column types

A column type is an Effect `Schema` plus the ClickHouse type name it stands for. That schema is
the single source of truth: the TypeScript column type is read off it, and `compile` folds the
selected columns' schemas into the row schema `decodeRows` validates against — see
[Decoding results](./decoding-results.md).

The constructors are values, not calls (except the parameterised ones):

| Constructor          | ClickHouse type   | Decodes to          | From the wire             |
| -------------------- | ----------------- | ------------------- | ------------------------- |
| `T.string`           | `String`          | `string`            | `string`                  |
| `T.uint8`            | `UInt8`           | `number`            | number or quoted number   |
| `T.uint16`           | `UInt16`          | `number`            | number or quoted number   |
| `T.uint32`           | `UInt32`          | `number`            | number or quoted number   |
| `T.uint64`           | `UInt64`          | `number`            | number or quoted number   |
| `T.int32`            | `Int32`           | `number`            | number or quoted number   |
| `T.float64`          | `Float64`         | `number`            | number or quoted number   |
| `T.bool`             | `Bool`            | `boolean`           | `true`/`false` or `1`/`0` |
| `T.dateTime`         | `DateTime`        | `DateTime.Utc`      | `YYYY-MM-DD hh:mm:ss`     |
| `T.dateTime64`       | `DateTime64`      | `DateTime.Utc`      | with a fractional part    |
| `T.dateTimeString`   | `DateTime`        | `string`            | unparsed, as sent         |
| `T.dateTime64String` | `DateTime64`      | `string`            | unparsed, as sent         |
| `T.map(k, v)`        | `Map(K, V)`       | `Record<string, V>` | object                    |
| `T.array(e)`         | `Array(E)`        | `ReadonlyArray<E>`  | array                     |
| `T.nullable(t)`      | `Nullable(T)`     | `T \| null`         | value or `null`           |
| `T.unknown(sql)`     | whatever you name | `unknown`           | unvalidated               |

Two of those deserve a note.

**64-bit integers.** ClickHouse's `FORMAT JSON` quotes them, a client that sets
`output_format_json_quote_64bit_integers=0` gets them bare, and a gateway
that refuses `output_format_json_quote_64bit_integers=0` quotes them regardless. Every integer
type accepts both and decodes to a `number` — which also means a `UInt64` above `2^53` cannot
survive: emit those as `toString(...)` in the SELECT and declare the column `T.string`.

**DateTimes.** ClickHouse sends `2026-05-24 14:30:00` — UTC, but with no zone marker, which
`new Date(…)` reads as _local_ time and shifts by the runtime's offset. `T.dateTime` parses it
correctly to a `DateTime.Utc`. Use `T.dateTimeString` when the row is being forwarded onto a wire
of its own and re-serializing the timestamp would change what your clients receive; the date
functions preserve whichever flavour they are given.

> **Import the namespace.** Every constructor is on the root barrel too, but
> `import * as T from "@maple-dev/clickhouse-builder/types"` — as above — reads better than
> `CH.string` and keeps column types visually distinct from the query DSL.

_(Backed by `docs/tables-and-types.md > Column types come from /types as a namespace`.)_

## `InferTS`

`InferTS<ColType>` maps a column type to its TypeScript type. You rarely need it directly —
`select` already infers output rows — but it is exported for writing your own helpers:

```ts
import type { InferTS } from "@maple-dev/clickhouse-builder"

type Ms = InferTS<typeof T.uint64> // number
```

`InferEncoded<ColType>` is its counterpart — the wire type the schema decodes _from_.

Related utilities: `ColumnDefs` (the shape of a `columns` record), `OutputToColumnDefs`
(converts a query's output row back into column defs, used by `fromQuery`), and
`NullableColumnDefs` (what `leftJoin` applies to the joined side).

## Map columns

`Map` columns get a `.get(key)` accessor that compiles to ClickHouse's bracket syntax:

```ts
const query = CH.from(Events)
	.select(($) => ({ method: $.Attributes.get("http.method") }))
	.where(($) => [$.OrgId.eq("org_123")])

// SELECT Attributes['http.method'] AS method FROM events WHERE OrgId = 'org_123'
```

`.get()` yields the map's _value_ type — `Expr<string>` for a `Map(String, String)`, `Expr<number>` for a `Map(String, UInt64)`. For the other map operations — `mapContains`,
`mapKeys`, `mapValues`, `mapGet`, `mapLiteral` — see the
[API reference](./reference.md#map).

_(Backed by `docs/tables-and-types.md > Reading a Map column`.)_

## Aliasing a table

`from()` takes an optional alias, which qualifies every column reference. You need this as
soon as a join introduces ambiguity:

```ts
CH.from(Events, "e") // FROM events AS e, columns emit as e.Name
```

See [Joins and subqueries](./joins-and-subqueries.md).
