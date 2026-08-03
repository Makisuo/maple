# Extending the DSL

The wrapped function catalog is deliberately partial — it covers what gets used, not all of
ClickHouse. There are four escape hatches, in increasing order of how much they give up.

## `defineFn` — declare a missing function

One line for any standard `fn(args…)` function. You supply the argument tuple and return type:

```ts
const toStartOfFiveMinute = CH.defineFn<[CH.Expr<string>], string>("toStartOfFiveMinute")

CH.from(Events)
	.select(($) => ({ bucket: toStartOfFiveMinute($.Timestamp) }))
	.where(($) => [$.OrgId.eq("org_123")])
// toStartOfFiveMinute(Timestamp) AS bucket
```

Arguments are compiled through the same escaping path as everything else, so raw values are
safe to pass. This is the right tool almost every time.

*(Backed by `docs/extending.md > defineFn declares a missing function`.)*

### `defineCondFn` — for predicates

Same, but returning a `Condition` so it can go straight into `where`:

```ts
const matchesRegex = CH.defineCondFn<[CH.Expr<string>, string]>("match")

.where(($) => [$.OrgId.eq("org_123"), matchesRegex($.Name, "^checkout")])
// match(Name, '^checkout')
```

*(Backed by `docs/extending.md > defineCondFn declares a predicate`.)*

## `compileFnCall` — variadic or generic shapes

When the signature is too irregular for `defineFn`, write the wrapper yourself:

```ts
import { compileFnCall, compileFnCallCond } from "@maple-dev/clickhouse-builder"

const greatestOf = <T>(...exprs: CH.Expr<T>[]) => compileFnCall<T>("greatest", ...exprs)
```

Arguments still route through the standard fragment conversion, so escaping is preserved.

## `makeExpr` / `makeCond` — custom SQL syntax

For functions whose call syntax is not `fn(a, b)` at all — parametric aggregates, operators,
anything bespoke:

```ts
import { makeExpr } from "@maple-dev/clickhouse-builder"
import { raw, compile } from "@maple-dev/clickhouse-builder/sql"

const quantileExact = (q: number) => (expr: CH.Expr<number>) =>
	makeExpr<number>(raw(`quantileExact(${q})(${compile(expr.toFragment())})`))
```

This is how the bundled `quantile` is built. You are now assembling SQL text: interpolate only
values you control, and route anything user-supplied through `str()` from the `/sql` subpath so
it gets escaped.

## Raw escape hatches

`rawExpr` and `rawCond` take a SQL string as-is:

```ts
CH.from(Events)
	.select(($) => ({ odd: CH.rawExpr<number>("DurationMs % 2") }))
	.where(($) => [$.OrgId.eq("org_123"), CH.rawCond("Name GLOBAL IN (SELECT 1)")])
```

> Neither escapes nor validates anything, and the type parameter on `rawExpr` is an assertion
> you are making, not a checked fact. **Never build one from user input.**

`dynamicColumn<T>(name)` (on the `/expr` subpath) is the same idea for a column name only known
at runtime.

*(Backed by `docs/extending.md > rawExpr and rawCond are the last resort`.)*

## Handwritten queries: `unsafeCompiledQuery`

When a query cannot be expressed by the builder at all, wrap the SQL so downstream code still
sees a uniform `CompiledQuery`:

```ts
const compiled = CH.unsafeCompiledQuery<{ readonly name: string }>({
	sql: "SELECT Name AS name FROM events WHERE OrgId = 'org_123'",
	tenantScope: "org",
	rowSchema: Schema.Struct({ name: Schema.String }),
})
```

`tenantScope` is **required** — it cannot be inferred from a string, and whatever you assert is
taken at face value. Supply a `rowSchema` too: handwritten SQL is exactly where schema drift
goes unnoticed, and without one `decodeRows` validates nothing. See
[Decoding results](./decoding-results.md).

*(Backed by `docs/extending.md > unsafeCompiledQuery wraps handwritten SQL`.)*

## The fragment AST

The `/sql` subpath exposes the layer everything above is built on:

```ts
import { raw, str, ident, int, join, as_, when, compile } from "@maple-dev/clickhouse-builder/sql"
```

- `str(value)` — an escaped string literal. **Use this for anything user-supplied.**
- `ident(name)` — an identifier
- `raw(sql)` — verbatim SQL, escaping nothing
- `int(value)`, `join(sep, ...frags)`, `as_(frag, alias)`, `when(cond, frag)`
- `compile(fragment)` — render a fragment to a string
- `escapeClickHouseString(value)` — the escaping primitive itself

`SqlFragment` is an Effect `Data.TaggedEnum`, so it pattern-matches cleanly if you build tooling
over it.
