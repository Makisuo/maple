# Building queries

A query starts with `from`, `fromQuery`, or `fromUnion` and is refined by chaining. Every
method returns a **new** query — nothing mutates.

```ts
const base = CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])

const limited = base.limit(10) // `base` still has no LIMIT
```

That makes shared base queries safe to hand around and specialise per caller.

*(Backed by `docs/queries.md > Queries are immutable`.)*

## `select`

Two forms.

**By column name** — output keys match the column names:

```ts
CH.from(Events).select("Name", "DurationMs")
// SELECT Name AS Name, DurationMs AS DurationMs FROM events
```

**By callback** — for computed expressions, aliases, and aggregates:

```ts
CH.from(Events).select(($) => ({
	name: $.Name,
	p95: CH.quantile(0.95)($.DurationMs),
	count: CH.count(),
}))
```

The object keys become the SQL aliases *and* the keys of the output row type. `select` is
required: compiling without one throws `QueryBuilderError` with code `SelectRequired`.

Calling `select` again replaces the previous projection rather than adding to it.

*(Backed by `docs/queries.md > select by column name`.)*

## `where`

`where` takes a callback returning an **array** of conditions, AND-joined together:

```ts
.where(($) => [
	$.OrgId.eq("org_123"),
	$.DurationMs.gt(1000),
])
```

Entries may be `undefined`, which drops them — that is what makes optional filters clean. See
[`when` / `whenTrue`](./expressions.md#optional-predicates).

The top-level array is also where [tenant scoping](./tenant-scoping.md) is detected, so prefer
listing predicates flatly over folding them together with `.and()`.

## `groupBy`

Takes **output keys** (the aliases from `select`), not raw column names:

```ts
.select(($) => ({ name: $.Name, count: CH.count() }))
.groupBy("name")
```

## `orderBy`

Takes `[column, direction]` tuples, one per sort key:

```ts
.orderBy(["count", "desc"], ["name", "asc"])
// ORDER BY count DESC, name ASC
```

> **This is the API's sharpest edge.** `.orderBy("count", "desc")` — two bare strings — is a
> type error, but if you reach it from untyped code it used to destructure each string into
> its first two characters and emit `ORDER BY c O, d E`. It now throws `QueryBuilderError`
> with code `InvalidOrderBySpec` instead.

*(Backed by `docs/queries.md > orderBy takes tuples` and `> orderBy rejects a bare string`.)*

## `limit` / `offset`

```ts
.limit(50).offset(100)
```

Both are rounded with `Math.round` before emission, so a fractional value cannot inject
anything.

## `format`

```ts
.format("JSON") // appends `FORMAT JSON`
```

Accepts `"JSON"` or `"JSONEachRow"`. Most clients set the format themselves; use this only
when you are sending raw SQL somewhere that does not.

## `withCTE`

See [Unions and CTEs](./unions-and-ctes.md#ctes).

## Routing and scope declarations

`.routing("ingest")` and `.crossOrg()` attach metadata to the compiled result rather than
changing the SQL. Both are covered in [Tenant scoping](./tenant-scoping.md).

## Compiling

```ts
const compiled = CH.compile(query, params, options?)
```

`compile` is an alias of `compileCH`; both are exported. Unions compile with `compileUnion`.
See [Params and compilation](./params-and-compilation.md).
