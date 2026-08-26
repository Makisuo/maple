# Getting started

## Install

```bash
bun add @maple-dev/clickhouse-builder effect@beta
# or: npm i @maple-dev/clickhouse-builder effect@beta
```

`effect` is a peer dependency — bring your own.

> **Note the `@beta` tag.** This package requires **Effect 4** (`>=4.0.0-beta.33`), which is
> not yet published under npm's `latest` tag. A bare `npm i effect` installs 3.x, and the
> package then throws `Schema.TaggedError is not a function` on import.

The package is ESM-only and ships its own type declarations.

## Describe a table

A `table()` call is the single source of truth for a query's types. Column names and types
flow from here into the select callback, the output row shape, and join accessors.

```ts
import * as CH from "@maple-dev/clickhouse-builder"
import * as T from "@maple-dev/clickhouse-builder/types"

const Events = CH.table(
	"events",
	{
		OrgId: T.string,
		Name: T.string,
		Timestamp: T.dateTime,
		DurationMs: T.uint64,
		Attributes: T.map(T.string, T.string),
	},
	// `OrgId` carries row-level tenancy, so filtering on it marks a query scoped.
	{ tenantColumn: "OrgId" },
)
```

This declares the shape you intend to query; it does not create or validate anything against a
real server. See [Tables and column types](./tables-and-types.md).

## Build a query

```ts
const query = CH.from(Events)
	.select(($) => ({
		name: $.Name,
		p95: CH.quantile(0.95)($.DurationMs),
		count: CH.count(),
	}))
	.where(($) => [$.OrgId.eq(CH.param.string("orgId")), $.Timestamp.gte(CH.param.dateTime("startTime"))])
	.groupBy("name")
	.orderBy(["count", "desc"])
	.limit(50)
```

The `$` passed to `select` and `where` is a typed accessor over the table's columns. The keys
of the object returned from `select` become both the SQL aliases and the keys of the output row
type — here `{ name: string; p95: number; count: number }`.

> `orderBy` takes `[column, direction]` **tuples**. `.orderBy("count", "desc")` is a type
> error, and fails compilation if you reach it from untyped code.

## Compile it

Compilation returns an `Effect` — a missing param or a value the column cannot hold is a typed
`QueryBuilderError` rather than a throw. The snippets below `yield*` it; reach for
`CH.compileUnsafe` where a throw is what you want.

```ts
const program = Effect.gen(function* () {
	const compiled = yield* CH.compile(query, {
		orgId: "org_123",
		startTime: "2026-01-01 00:00:00",
	})
	return compiled
})

const compiled = await Effect.runPromise(program)

compiled.sql
// SELECT Name AS name, quantile(0.95)(DurationMs) AS p95, count() AS count
// FROM events
// WHERE OrgId = 'org_123' AND Timestamp >= '2026-01-01 00:00:00'
// GROUP BY name ORDER BY count DESC LIMIT 50
```

The second argument resolves the `param.*` placeholders. Values are escaped and substituted
into the SQL text at compile time — this is not server-side parameter binding. See
[Params and compilation](./params-and-compilation.md).

_(Backed by `docs/getting-started.md > Your first query`.)_

## Run and decode

The builder never talks to ClickHouse. Execute `compiled.sql` with whatever client you already
use, then hand the rows back for decoding:

```ts
import { Effect, Schema } from "effect"

const compiled = CH.compileUnsafe(query, params, {
		rowSchema: Schema.Struct({
			name: Schema.String,
			count: Schema.Number,
		}),
	})

const result = await client.query({ query: compiled.sql, format: "JSONEachRow" })
const rows = await Effect.runPromise(compiled.decodeRows(await result.json()))
```

`client` is your own — see [Running a query](./running-queries.md) for the full example.

Passing a `rowSchema` gets you real validation of what came back off the wire. Without one,
`decodeRows` degrades to a pass-through cast and validates nothing — `compiled.rowSchemaSource`
tells you which you got (`"declared"`, `"derived"`, or `"none"`). There is deliberately no `castRows`; see
[Decoding results](./decoding-results.md).

_(Backed by `docs/getting-started.md > Decoding the results`.)_

## Where to next

- [Building queries](./queries.md) — the full builder surface
- [Expressions and conditions](./expressions.md) — predicates, arithmetic, aggregates
- [Tenant scoping](./tenant-scoping.md) — what `compiled.tenantScope` means
