# Running a compiled query

This package never touches the network. `compile` gives you a `CompiledQuery`: a SQL string, the
tenant scope it derived, and a decoder for the rows. Executing it is your client's job, and this
page is the missing half — the twenty lines that close the loop, with the two wire details the
column types already assume.

## The whole loop, with `@clickhouse/client`

```ts
import { createClient } from "@clickhouse/client"
import { Effect } from "effect"
import * as CH from "@maple-dev/clickhouse-builder"

const client = createClient({ url: "http://localhost:8123", username: "default", password: "" })

const run = <Row>(compiled: CH.CompiledQuery<Row>) =>
	Effect.tryPromise(() =>
		client.query({
			query: compiled.sql,
			format: "JSONEachRow",
			clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
		}),
	).pipe(
		Effect.flatMap((result) => Effect.tryPromise(() => result.json<Record<string, unknown>>())),
		Effect.flatMap(compiled.decodeRows),
	)

const program = Effect.gen(function* () {
	const compiled = yield* CH.compile(query, { orgId: "org_123", startTime: "2026-01-01 00:00:00" })
	return yield* run(compiled)
})
```

Three things are load-bearing:

**`format: "JSONEachRow"`** — the client's own format, not a `FORMAT` clause in the SQL. Set
`.format("JSON")` on the query instead and the client is handed a document it did not expect. Pick
one, and for a client call it should be this one.

**`output_format_json_quote_64bit_integers: 0`** — ClickHouse quotes `UInt64`/`Int64` as JSON
strings by default, because they do not survive a JS `number` above 2^53. The column types model
both forms (`T.uint64` accepts `12` and `"12"`), so decoding works either way and this setting is
about what you get, not whether it parses. What it does **not** rescue is an identity — a hash, a
snowflake id — above 2^53: turn the setting off and that value silently loses precision on the way
in. Project those with `toString()` in the SELECT and declare them `T.string`.

**`compiled.decodeRows`** — the rows arrive as `Record<string, unknown>`. `decodeRows` is what
turns them into `Row`, and it fails with `CompiledQueryDecodeError` naming the offending
`rowIndex` when the wire disagrees with the schema. See
[Decoding results](./decoding-results.md).

`compiled.tenantScope` is worth a look before the call rather than after — see
[Tenant scoping](./tenant-scoping.md) for why an executor should refuse a `"cross-tenant"` query
on its normal read path.

## Attaching `SETTINGS`

`CompiledQuery.sql` has no settings clause and no way to pass one: query settings are an execution
concern, and the builder does not execute. Most clients take them out of band, which is what the
example above does.

When they have to travel *in the SQL* — a gateway that forwards a statement verbatim, a
`/v0/sql`-style endpoint that takes one string — the `/sql` subpath has the two functions for it:

```ts
import { parseStatement, renderStatement, withSettings } from "@maple-dev/clickhouse-builder/sql"

const statement = withSettings(
	parseStatement(compiled.sql),
	"SETTINGS max_execution_time = 30, max_threads = 4",
)
statement.text // the body, then SETTINGS, then FORMAT
```

`parseStatement` splits a statement into `body` / `settings` / `format` and `renderStatement` (or
`.text`) puts it back together **in that order** — `SETTINGS` before `FORMAT`, which is the order
ClickHouse accepts and the inverse of what string concatenation gives you. It is total: any string
has a body, so a statement with no terminal clauses round-trips unchanged. `withFormat` is the
same edit for the format clause, and `ClickHouseStatementFromString` is the pair as a codec, for a
boundary that stores a statement as text but wants the parsed shape in hand.

Appending `SETTINGS …` to `compiled.sql` by hand is the thing to avoid: a query that already ends
in `FORMAT JSON` — anything built with `.format(…)` — produces a syntax error, and a body ending in
a `--` comment swallows whatever you appended.

_(Backed by `docs/running-queries.md > SETTINGS precede FORMAT whatever order you add them in`.)_

## Cost profiles, retries, tenancy

None of that is here on purpose. A `CompiledQuery` is a value: it can be cached, logged,
fingerprinted, or handed to a different executor per tenant, and every one of those policies
belongs to the application rather than the builder. What the builder guarantees is that the value
describes itself — its SQL, its tenant scope, and how its rows decode.
