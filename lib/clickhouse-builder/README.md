# @maple-dev/clickhouse-builder

A type-safe, immutable ClickHouse SQL query builder for TypeScript.

- **Schema-first** — a column type _is_ an Effect `Schema`, so a query compiles
  to its own row schema. `decodeRows` validates without you writing one, and the
  wire quirks (64-bit ints arriving quoted, tz-less DateTimes) are modelled once
  in the types rather than rediscovered per consumer.
- **Type-safe** — define a table once and the query builder infers column types,
  output row shapes, and join accessors. No stringly-typed columns.
- **Immutable & composable** — every builder method returns a new query; share
  and extend base queries without surprises.
- **ClickHouse-native** — first-class helpers for the functions you actually use
  (`quantile`, `toStartOfInterval`, `mapGet`, window functions, …) plus escape
  hatches (`rawExpr`, `rawCompiledQuery`) for anything not yet modeled.
- **Parameterised compilation** — compile to a SQL string with named params
  resolved and string literals escaped. A param with no value, or a value of the
  wrong kind, fails the compile instead of reaching the server.

Built on [Effect](https://effect.website) (peer dependency).

## Install

```bash
bun add @maple-dev/clickhouse-builder effect@rc
# or: npm i @maple-dev/clickhouse-builder effect@rc
```

`effect` is a peer dependency — bring your own. Note the `@rc` tag: this package
requires **Effect 4** (`>=4.0.0-rc.111`), which is not on npm's `latest` tag.
Installing a bare `effect` gets you 3.x, and the package will throw
`Schema.TaggedError is not a function` on import.

## Quick start

```ts
import * as CH from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"

// 1. Describe a table
const Events = CH.table(
	"events",
	{
		OrgId: T.string,
		Name: T.string,
		Timestamp: T.dateTime,
		DurationMs: T.uint64,
		Attributes: T.map(T.string, T.string),
	},
	// Optional: name the column carrying row-level tenancy and every compiled
	// query reports whether it pinned it. See docs/tenant-scoping.md.
	{ tenantColumn: "OrgId" },
)

// 2. Build a query
const query = CH.from(Events)
	.select(($) => ({
		name: $.Name,
		p95: CH.quantile(0.95)($.DurationMs),
		count: CH.count(),
	}))
	.where(($) => [
		$.OrgId.eq(CH.param.string("orgId")),
		$.Timestamp.gte(CH.param.dateTime("startTime")),
		CH.when(true, () => $.Name.like("checkout%")),
	])
	.groupBy("name")
	.orderBy(["count", "desc"])
	.limit(50)

// 3. Compile to SQL (params resolved, literals escaped)
const compiled = CH.compileUnsafe(query, {
	orgId: "org_123",
	startTime: "2026-01-01 00:00:00",
})

compiled.sql // -> SELECT Name AS name, quantile(0.95)(DurationMs) AS p95, ...
```

## Decoding results

Run the SQL with your own ClickHouse client, then hand the rows back to
`decodeRows`. The row schema comes from the query itself — every column type is
a `Schema`, so the SELECT already describes its own rows:

```ts
import { Effect } from "effect"

const compiled = CH.compileUnsafe(query, { orgId: "org_123", startTime: "2026-01-01 00:00:00" })

compiled.rowSchemaSource // "derived"
const result = await client.query({ query: compiled.sql, format: "JSONEachRow" })
const rows = await Effect.runPromise(compiled.decodeRows(await result.json()))
// -> ReadonlyArray<{ name: string; p95: number; count: number }>
```

`client` is your own ClickHouse client — the builder brings none.
[Running a query](./docs/running-queries.md) has the full loop and the wire settings that go
with it.

`count()` is a `UInt64`, which ClickHouse's `FORMAT JSON` quotes and a gateway with
`output_format_json_quote_64bit_integers=0` does not — the
column type accepts either, so the same code works against both backends. That
is the class of drift a bare cast used to hide, which is why there is no
`castRows`.

Pass a `rowSchema` explicitly to **narrow** what the builder inferred (a `String`
column as a literal union, say); it wins over the derived one. If any selected
expression has no type to read — an `untypedExpr`, a `defineUntypedFn` —
nothing is derived, `rowSchemaSource` is `"none"`, and `decodeRows` degrades to
a pass-through rather than pretending.

Compilation itself is Effect-returning: a param with no value, or a value the
column cannot hold, is a `QueryBuilderError` in the error channel rather than a
throw, so a route can `catchTag` it instead of crashing. `compileUnsafe` is the
throwing variant, for a fixture or a catalog sweep where a query that will not
compile should fail loudly. A bug inside a callback stays a defect either way.

`decodeFirstRow` is the point-lookup variant, returning `Option<Output>` so you
don't hand-roll `rows[0] ?? null`. Both fail with `CompiledQueryDecodeError`,
which carries the offending `rowIndex`. When a query does derive nothing,
`untypedColumns` names the selected aliases responsible.

`encodeRows` runs the same schema backwards, turning decoded rows into the wire
shape ClickHouse sent. That is what lets a service hold the good value in memory
and still emit the bytes its own clients parse: a `DateTime` column decoded to a
`DateTime.Utc` re-encodes to `'YYYY-MM-DD hh:mm:ss'`, not to ISO-8601, because
the column's codec is the authority on both directions.

## Documentation

Full guides live in [`docs/`](./docs/README.md):

| Guide                                                      | What it covers                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| [Getting started](./docs/getting-started.md)               | Install, define a table, build → compile → decode              |
| [Tables and column types](./docs/tables-and-types.md)      | `table()`, column-type constructors, `Map`/`Array`/`Nullable`  |
| [Building queries](./docs/queries.md)                      | `select`, `where`, `groupBy`, `orderBy`, `limit`, immutability |
| [Expressions and conditions](./docs/expressions.md)        | Comparisons, arithmetic, optional predicates, aggregates       |
| [Joins and subqueries](./docs/joins-and-subqueries.md)     | The join family, `fromQuery`, correlated subqueries            |
| [Unions and CTEs](./docs/unions-and-ctes.md)               | `unionAll`, `fromUnion`, `withCTE`                             |
| [Params and compilation](./docs/params-and-compilation.md) | `param.*`, how values reach the SQL, `CompiledQuery`           |
| [Decoding results](./docs/decoding-results.md)             | `rowSchema`, `decodeRows`, decode errors                       |
| [Running a query](./docs/running-queries.md)               | Executing the SQL with a real client, wire settings, `SETTINGS` |
| [Tenant scoping](./docs/tenant-scoping.md)                 | `tenantColumn`, what marks a query scoped, `crossTenant()`     |
| [Extending the DSL](./docs/extending.md)                   | `defineFn`, raw escape hatches, handwritten SQL                |
| [API reference](./docs/reference.md)                       | Full export catalog by module, plus error types                |

Every code block in those guides is backed by a test in
[`src/docs-examples.test.ts`](./src/docs-examples.test.ts) that compiles the
query and asserts the emitted SQL.

## Entry points

| Import                                | Contents                                                                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@maple-dev/clickhouse-builder`       | Curated public API: `from`, `compile`, `param`, expression helpers, and ClickHouse functions under friendly names (`min`, `max`, `count`, `quantile`, …).                                       |
| `@maple-dev/clickhouse-builder/types` | Column-type constructors (`string`, `uint64`, `dateTime`, `map`, `array`, `nullable`, …) and the `CH*` type descriptors.                                                                        |
| `@maple-dev/clickhouse-builder/expr`  | Kitchen-sink namespace: every expression helper plus all ClickHouse functions under their raw names (`min_`, `toString_`, `toStartOfInterval`, `dynamicColumn`, …). Handy for `import * as CH`. |
| `@maple-dev/clickhouse-builder/sql`   | The low-level `SqlFragment` AST (`raw`, `ident`, `compile`, …) for hand-rolling fragments.                                                                                                      |

## Extending with custom functions

```ts
import { defineFn, sameAs } from "@maple-dev/clickhouse-builder"

// Declare any ClickHouse function not already wrapped. The second argument is
// the ClickHouse type it returns — required, because that is what lets a query
// using it still derive its row schema.
const toStartOfFiveMinute = defineFn<[CH.Expr<DateTime.Utc>], DateTime.Utc>("toStartOfFiveMinute", T.dateTime)

// When the result type depends on the arguments — `min`, `argMax`, `coalesce`,
// `arrayJoin` all hand back one of their inputs — pass a rule instead:
// `sameAs(i)`, `firstTyped()`, `elementOf(i)`, `arrayOfArg(i)`.
const anyLast = defineFn<[CH.Expr<string>], string>("anyLast", sameAs(0))
```

## License

MIT
