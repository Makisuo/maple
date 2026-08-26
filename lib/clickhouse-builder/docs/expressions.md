# Expressions and conditions

Two brands flow through the DSL. An **`Expr<T>`** is anything that evaluates to a value — a
column, a literal, a function call. A **`Condition`** is a boolean predicate, which is what
`where` collects. Comparison methods turn an `Expr` into a `Condition`.

## How a value becomes a literal

Comparing a column against a plain value encodes that value through the column's own type, so
the literal is whatever ClickHouse expects for _that_ column rather than whatever the JavaScript
value looks like:

```ts
$.Attributes.eq({ "http.method": "GET" }) // Attributes = map('http.method', 'GET')
$.Tags.eq(["a", "b"])                     // Tags = ['a', 'b']
$.Live.eq(true)                           // Live = 1
$.Note.eq(null)                           // Note = NULL
$.Timestamp.gte(new Date(...))            // Timestamp >= '2026-01-01 00:00:00'
```

A value the column cannot hold fails while the SQL is being built:

```ts
$.Count.eq("lots")
// QueryBuilderError { code: "InvalidLiteral" }: column Count: string "lots" is not a valid value
```

Expressions with no type to read — `untypedExpr`, an untyped `dynamicColumn` — fall back to
guessing from the JavaScript value, which handles strings, numbers, booleans and dates but
nothing structured.

_(Backed by `src/ch/literal.test.ts`.)_

## Comparisons

Every `Expr<T>` carries:

| Method                          | SQL                     |
| ------------------------------- | ----------------------- |
| `.eq(x)` / `.neq(x)`            | `= x` / `!= x`          |
| `.gt(x)` / `.gte(x)`            | `> x` / `>= x`          |
| `.lt(x)` / `.lte(x)`            | `< x` / `<= x`          |
| `.in_(...xs)` / `.notIn(...xs)` | `IN (…)` / `NOT IN (…)` |

Each accepts a raw value or another `Expr<T>`. String literals are escaped; booleans emit as
`1` / `0`.

`in_` carries a trailing underscore because `in` is a reserved word in JavaScript.

### String-only

`.like(pattern)`, `.notLike(pattern)`, `.ilike(pattern)` are constrained by `this` to
`Expr<string>`, so calling them on a numeric column is a type error.

## Combining conditions

```ts
.where(($) => [
	$.OrgId.eq("org_123"),
	$.Name.eq("checkout").or($.Name.eq("cart")),
])
// … WHERE OrgId = 'org_123' AND (Name = 'checkout' OR Name = 'cart')
```

`.and()` / `.or()` parenthesise their result, so precedence is explicit. `not(condition)` wraps
in `NOT (…)` and is available from the `/expr` subpath.

Prefer listing predicates as separate array entries over `.and()`-chaining them — the array is
AND-joined anyway, and [tenant scoping](./tenant-scoping.md) is only detected on top-level
entries.

_(Backed by `docs/expressions.md > Combining conditions with and/or`.)_

## Optional predicates

`when` and `whenTrue` return `Condition | undefined`, and `where` drops `undefined` entries.
This is how you build filters from optional inputs without string-concatenating SQL:

```ts
const build = (nameFilter?: string) =>
	CH.from(Events)
		.select(($) => ({ name: $.Name }))
		.where(($) => [$.OrgId.eq("org_123"), CH.when(nameFilter, (n) => $.Name.eq(n))])

// build("checkout") -> … WHERE OrgId = 'org_123' AND Name = 'checkout'
// build()           -> … WHERE OrgId = 'org_123'
```

`when` skips `undefined`, `null`, and `false`, and narrows the value for the callback.
`whenTrue(flag, () => cond)` is the variant for a plain boolean gate.

_(Backed by `docs/expressions.md > Optional predicates with when`.)_

## Arithmetic

`Expr<number>` carries `.add()`, `.sub()`, `.mul()`, `.div()`.

> **These do not parenthesise.** Chaining follows SQL operator precedence, not call order:
>
> ```ts
> $.DurationMs.sub(1).div(2)
> // DurationMs - 1 / 2   →  DurationMs - (1 / 2)
> // NOT (DurationMs - 1) / 2
> ```
>
> Order the calls so precedence works in your favour, or bind an intermediate alias in a
> subquery. This is a deliberate trade — the emitted SQL stays readable — but it is the most
> common source of quietly wrong numbers.

_(Backed by `docs/expressions.md > Arithmetic does not parenthesise`.)_

### Division can produce a NULL

`.div()` and `.mod()` decode nullably, whatever their operands are. ClickHouse renders `1 / 0` as
`inf` and `0 / 0` as `nan`, and both come back as JSON `null` — so a division that meets a zero
denominator returns a null the column type has to accept, or the row fails to decode.

That costs nothing at the type level: the result is `Expr<number>` either way, exactly as it
already was for a division with a nullable operand. What it buys is that an unguarded division
which hits a zero in production is the `null` the wire actually carried, rather than a decode
failure on a query that ran fine.

When you want a number rather than a null, guard it in SQL:

```ts
.select(($) => ({
	// ifNotFinite(sum(Errors) / sum(Total), 0) AS errorRate
	errorRate: CH.ifNotFinite(CH.sum($.Errors).div(CH.sum($.Total)), 0),
}))
```

`CH.ifNotFinite(expr, fallback)` is `expr` unless it is `nan`/`inf`, in which case it is
`fallback` — and its result is non-nullable, because the guard is in the SQL. The other standard
shape, `CH.sum(x).div(CH.nullIf(CH.sum(y), 0))`, deliberately keeps the null: "an average, or
nothing when there is nothing to average over".

The other four operators stay strict. `+`, `-`, `*` and unary use cannot manufacture a null out
of two finite operands, so the looseness is bought only where it is paid for.

_(Backed by `docs/expressions.md > division decodes nullably and ifNotFinite guards it`.)_

## Literals and raw escape hatches

- `lit(value)` — an explicit `Expr` from a `string` or `number`. You rarely need it, since
  comparison methods accept raw values directly.
- `rawExpr(sql, type)` — an `Expr` from a SQL string, with the column type it produces.
- `untypedExpr<T>(sql)` — the same with no type declared; selecting one costs the query its
  row schema, so it is a separate name rather than an omitted argument.
- `rawCond(sql)` — a `Condition` from a SQL string.

Raw helpers interpolate nothing and escape nothing. Never build one from user input. See
[Extending the DSL](./extending.md).

## Aggregates

`count()`, `sum()`, `avg()`, `min()`, `max()`, `uniq()`, `groupUniqArray()`, `argMaxMerge()`,
and the conditional forms `countIf()`, `sumIf()`, `avgIf()`, `minIf()`, `maxIf()`, `anyIf()`.

The `*If` family takes a `Condition` as its last argument:

```ts
.select(($) => ({
	total: CH.count(),
	slow: CH.countIf($.DurationMs.gt(1000)),
}))
// count() AS total, countIf(DurationMs > 1000) AS slow
```

`quantile` is curried, taking the quantile first:

```ts
CH.quantile(0.95)($.DurationMs) // quantile(0.95)(DurationMs)
```

So are the parametric funnel aggregates — the window / pattern is a parameter,
the timestamp and step conditions are the arguments:

```ts
CH.windowFunnel(3600)($.Timestamp, $.Name.eq("view"), $.Name.eq("signup"))
// windowFunnel(3600)(Timestamp, Name = 'view', Name = 'signup')
CH.windowFunnel(3600, "strict_order")($.Timestamp, …)
CH.sequenceMatch("(?1)(?t<3600)(?2)")($.Timestamp, $.Name.eq("view"), $.Name.eq("signup"))
```

`windowFunnel` takes `Date`, `DateTime` or an unsigned integer for the timestamp
(not `DateTime64`) and the window is in that column's unit.

_(Backed by `docs/expressions.md > Conditional aggregation`.)_

## Conditionals

- `if_(cond, then, else)` — note the underscore; `if` is a reserved word.
- `multiIf([[cond, value], …], fallback)`
- `coalesce(...exprs)`
- `nullIf(expr, value)`

## Everything else

String, numeric, date/time, array, map, JSON, and window functions are catalogued in the
[API reference](./reference.md#clickhouse-functions). Anything not wrapped can be declared in
one line with [`defineFn`](./extending.md).
