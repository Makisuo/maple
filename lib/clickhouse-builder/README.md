# @maple-dev/clickhouse-builder

A type-safe, immutable ClickHouse SQL query builder for TypeScript.

- **Schema-first** — a column type *is* an Effect `Schema`, so a query compiles
  to its own row schema. `decodeRows` validates without you writing one, and the
  wire quirks (64-bit ints arriving quoted, tz-less DateTimes) are modelled once
  in the types rather than rediscovered per consumer.
- **Type-safe** — define a table once and the query builder infers column types,
  output row shapes, and join accessors. No stringly-typed columns.
- **Immutable & composable** — every builder method returns a new query; share
  and extend base queries without surprises.
- **ClickHouse-native** — first-class helpers for the functions you actually use
  (`quantile`, `toStartOfInterval`, `mapGet`, window functions, …) plus escape
  hatches (`rawExpr`, `unsafeCompiledQuery`) for anything not yet modeled.
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
const compiled = CH.compile(query, {
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

const compiled = CH.compile(query, { orgId: "org_123", startTime: "2026-01-01 00:00:00" })

compiled.rowSchemaSource // "derived"
const rows = await Effect.runPromise(compiled.decodeRows(await runOnClickHouse(compiled.sql)))
// -> ReadonlyArray<{ name: string; p95: number; count: number }>
```

`count()` is a `UInt64`, which ClickHouse quotes and Tinybird does not — the
column type accepts either, so the same code works against both backends. That
is the class of drift a bare cast used to hide, which is why there is no
`castRows`.

Pass a `rowSchema` explicitly to **narrow** what the builder inferred (a `String`
column as a literal union, say); it wins over the derived one. If any selected
expression has no type to read — a `rawExpr`, an un-annotated `defineFn` —
nothing is derived, `rowSchemaSource` is `"none"`, and `decodeRows` degrades to
a pass-through rather than pretending.

`decodeFirstRow` is the point-lookup variant, returning `Option<Output>` so you
don't hand-roll `rows[0] ?? null`. Both fail with `CompiledQueryDecodeError`,
which carries the offending `rowIndex`.

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
import { defineFn } from "@maple-dev/clickhouse-builder"

// Declare any ClickHouse function not already wrapped.
// The second argument is the ClickHouse type it returns — that is what lets a
// query using it still derive its row schema.
const toStartOfFiveMinute = defineFn<[CH.Expr<DateTime.Utc>], DateTime.Utc>(
	"toStartOfFiveMinute",
	T.dateTime,
)
```

## License

MIT
