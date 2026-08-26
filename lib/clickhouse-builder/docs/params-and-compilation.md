# Params and compilation

## Declaring params

```ts
CH.param.string("orgId")
CH.param.int("limit")
CH.param.float("threshold")
CH.param.bool("includeDrafts")
CH.param.dateTime("startTime")
```

Those five are the whole set. A param is an `Expr` placeholder usable anywhere an expression
is — most often on the right of a comparison:

```ts
.where(($) => [$.OrgId.eq(CH.param.string("orgId"))])
```

Calling a comparison method **on** an unresolved param (rather than passing it as an argument)
throws `QueryBuilderError` with code `UnresolvedParam`, since there is nothing to compare yet.

Param names must be alphanumeric, optionally separated by single underscores — the name travels
through the placeholder that `compile` later matches, and `__` would make its boundary
ambiguous. A name that cannot round-trip is rejected at declaration.

## What each kind accepts

The declared kind is checked when the value arrives, so a value of the wrong shape is a
compilation failure rather than SQL text that happens to contain it:

| Kind       | Accepts                                                 | Emits                           |
| ---------- | ------------------------------------------------------- | ------------------------------- |
| `string`   | a string                                                | an escaped literal, `'org_123'` |
| `int`      | a safe integer                                          | `50`                            |
| `float`    | any finite number                                       | `0.95`                          |
| `bool`     | a boolean                                               | `1` / `0`                       |
| `dateTime` | `'YYYY-MM-DD hh:mm:ss'`, a `Date`, or a `DateTime.Utc`  | `'2026-01-01 00:00:00'`         |

Each kind names a column type, and the value is encoded through that type's
schema — the same schema a column of that type decodes rows with, read backwards. The two
directions cannot drift, because there is only one of them.

`param.of(type, name)` takes it further: any column type, including one you declared with
`T.custom`, works as a param.

```ts
const Level = T.custom("Enum8", Schema.Literals(["warn", "error"]))

CH.from(Events)
	.select(($) => ({ n: CH.count() }))
	.where(($) => [$.Level.eq(CH.param.of(Level, "level"))])

CH.compile(query, { level: "warn" })   // … WHERE Level = 'warn'
CH.compile(query, { level: "banana" }) // throws — the schema rejected it
```

```ts
CH.compile(query, { startTime: new Date("2026-01-01T00:00:00Z") })
// … WHERE Timestamp >= '2026-01-01 00:00:00'

CH.compile(query, { limit: 10.5 })
// throws QueryBuilderError { code: "InvalidParamValue" } — use param.float for fractions

CH.compile(query, {})
// throws QueryBuilderError { code: "UnresolvedParam" }: no value given for param 'orgId'
```

Params the query never mentions are ignored, so one bag of params can serve a family of
queries.

_(Backed by `src/ch/core-dsl.test.ts > param resolution`.)_

## How params are resolved

> **Params are resolved at compile time, not execution time.** `compile` substitutes each
> value into the SQL text. This is _not_ server-side parameter binding — ClickHouse never sees
> a placeholder.

```ts
const compiled = CH.compile(query, { orgId: "org_123" })
compiled.sql // … WHERE OrgId = 'org_123'
```

Two consequences worth planning around:

- **Every distinct parameter set produces a distinct SQL string.** If you cache or fingerprint
  by SQL text, each value is its own entry.
- **Escaping is the safety mechanism**, not binding. String values go through
  `escapeClickHouseString`, which escapes backslashes and single quotes:

    ```ts
    CH.compile(query, { orgId: "a'b\\c" })
    // … WHERE OrgId = 'a\'b\\c'
    ```

    Values flowing through `param.*` and the comparison methods are escaped. Values you splice
    in via [`rawExpr` / `rawCond`](./extending.md#raw-escape-hatches) are **not** — never build
    those from user input.

A query is a reusable template: compile the same one repeatedly with different params.

_(Backed by `docs/params-and-compilation.md > Params are resolved at compile time`,
`> String params are escaped`, `> One query, many parameter sets`.)_

## `compile`

```ts
CH.compile(query, params, options?)
```

| Argument             | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `query`              | The `CHQuery` to compile                                         |
| `params`             | Record resolving every `param.*` placeholder by name             |
| `options.rowSchema`  | Effect `Schema` used by `decodeRows` / `decodeFirstRow`          |
| `options.skipFormat` | Omit a trailing `FORMAT` clause (used internally for subqueries) |
| `options.deferParams` | Leave placeholders unresolved, for SQL spliced into an outer compile |

`compile` and `compileCH` are the same function. Unions use `compileUnion(union, params)`.

## The `CompiledQuery`

```ts
interface CompiledQuery<Output> {
	readonly sql: string
	readonly tenantScope: "tenant" | "cross-tenant"
	readonly rowSchemaDeclared: boolean
	readonly routing?: string
	readonly decodeRows: (rows) => Effect<ReadonlyArray<Output>, CompiledQueryDecodeError>
	readonly decodeFirstRow: (rows) => Effect<Option<Output>, CompiledQueryDecodeError>
}
```

| Field                           | Purpose                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `sql`                           | The statement to execute. The builder never runs it.                                         |
| `tenantScope`                   | Whether the query pins a single tenant — see [Tenant scoping](./tenant-scoping.md)           |
| `rowSchemaDeclared`             | Whether a `rowSchema` was supplied, so a caller can tell real validation from a pass-through |
| `routing`                       | Set by `.routing(tag)`; opaque metadata for your executor                                    |
| `decodeRows` / `decodeFirstRow` | See [Decoding results](./decoding-results.md)                                                |

There is deliberately **no `castRows`**. A bare cast looked type-safe while hiding wire-format
drift, so it was removed in favour of schema-checked decoding.

## Handwritten SQL

When you need SQL the builder cannot express, `unsafeCompiledQuery` wraps a string in the same
`CompiledQuery` interface so downstream code is uniform. `tenantScope` is required there,
because it cannot be inferred from a string. See [Extending the DSL](./extending.md).

## Errors

`QueryBuilderError` is thrown synchronously during compilation, with a `code`:

| Code                 | Cause                                                        |
| -------------------- | ------------------------------------------------------------ |
| `SelectRequired`     | Compiling a query with no `select()`                             |
| `UnresolvedParam`    | A param with no value, or compared on before it was resolved     |
| `InvalidParamValue`  | A param value that is not what its kind accepts                  |
| `InvalidParamName`   | A param name that cannot round-trip through its placeholder      |
| `InvalidOrderBySpec` | An `orderBy` entry that is not a `[column, direction]` tuple     |

It is an Effect `Schema.TaggedError`, catchable by the tag
`"@maple-dev/clickhouse-builder/QueryBuilderError"`.
