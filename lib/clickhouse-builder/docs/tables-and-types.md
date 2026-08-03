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

The type constructors are values, not calls (except the parameterised ones):

| Constructor | ClickHouse type | TypeScript type |
| --- | --- | --- |
| `T.string` | `String` | `string` |
| `T.uint8` | `UInt8` | `number` |
| `T.uint16` | `UInt16` | `number` |
| `T.uint32` | `UInt32` | `number` |
| `T.uint64` | `UInt64` | `number` |
| `T.int32` | `Int32` | `number` |
| `T.float64` | `Float64` | `number` |
| `T.bool` | `Bool` | `boolean` |
| `T.dateTime` | `DateTime` | `string` |
| `T.dateTime64` | `DateTime64` | `string` |
| `T.map(k, v)` | `Map(K, V)` | `Record<string, V>` |
| `T.array(e)` | `Array(E)` | `ReadonlyArray<E>` |
| `T.nullable(t)` | `Nullable(T)` | `T \| null` |

Date/time columns are typed as `string` on purpose: ClickHouse returns them as strings over
JSON, and the builder does not parse them for you.

> **Not every constructor is on the root barrel.** `T.uint16`, `T.uint32`, `T.int32`, and
> `T.bool` are reachable only through `@maple-dev/clickhouse-builder/types`. Importing the
> whole namespace as `T` — as above — is the simplest way to avoid the distinction entirely.

*(Backed by `docs/tables-and-types.md > Types outside the curated barrel come from /types`.)*

## `InferTS`

`InferTS<ColType>` maps a column type to its TypeScript type. You rarely need it directly —
`select` already infers output rows — but it is exported for writing your own helpers:

```ts
import type { InferTS } from "@maple-dev/clickhouse-builder"

type Ms = InferTS<typeof T.uint64> // number
```

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

`.get()` always yields `Expr<string>`. For the other map operations — `mapContains`,
`mapKeys`, `mapValues`, `mapGet`, `mapLiteral` — see the
[API reference](./reference.md#map).

*(Backed by `docs/tables-and-types.md > Reading a Map column`.)*

## Aliasing a table

`from()` takes an optional alias, which qualifies every column reference. You need this as
soon as a join introduces ambiguity:

```ts
CH.from(Events, "e") // FROM events AS e, columns emit as e.Name
```

See [Joins and subqueries](./joins-and-subqueries.md).
