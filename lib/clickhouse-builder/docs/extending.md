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

_(Backed by `docs/extending.md > defineFn declares a missing function`.)_

### `defineCondFn` — for predicates

Same, but returning a `Condition` so it can go straight into `where`:

```ts
const matchesRegex = CH.defineCondFn<[CH.Expr<string>, string]>("match")

	.where(($) => [$.OrgId.eq("org_123"), matchesRegex($.Name, "^checkout")])
// match(Name, '^checkout')
```

_(Backed by `docs/extending.md > defineCondFn declares a predicate`.)_

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

## A column type of your own

`T.custom(sql, schema)` is the extension point the built-in types are built from — `T.uint64` is
`custom("UInt64", CHNumber)`. Declare one for a ClickHouse type this package does not model and
it works everywhere a built-in does: rows decode through it, literals encode through it, and
`param.of(type, name)` takes it as a param.

```ts
const Level = T.custom("Enum8", Schema.Literals(["warn", "error"]))
const Decimal = T.custom("Decimal(18, 4)", Schema.FiniteFromString)

const Logs = CH.table("logs", { OrgId: T.string, Level, Amount: Decimal })
```

Pass a third argument when comparisons should accept more than the column decodes to — that is
how a `DateTime` column takes a `DateTime.Utc`, a `Date`, or the string form and writes the same
literal for all three.

_(Backed by `src/ch/literal.test.ts > param.of`.)_

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

_(Backed by `docs/extending.md > rawExpr and rawCond are the last resort`.)_

## Handwritten queries: `unsafeCompiledQuery`

When a query cannot be expressed by the builder at all, wrap the SQL so downstream code still
sees a uniform `CompiledQuery`:

```ts
const compiled = CH.unsafeCompiledQuery<{ readonly name: string }>({
	sql: "SELECT Name AS name FROM events WHERE OrgId = 'org_123'",
	tenantScope: "tenant",
	reason: "user-authored-sql",
	note: "The SQL came from a user; there is no AST to build.",
	rowSchema: Schema.Struct({ name: Schema.String }),
})
```

`tenantScope` is **required** — it cannot be inferred from a string, and whatever you assert is
taken at face value. That is the whole hazard: this is the one place tenant scope is asserted
rather than derived, so a query that forgot its tenant predicate would be positively _claimed_
as scoped and sail through an executor's gate.

`reason` and `note` are therefore required too. What counts as a legitimate reason is a policy
of your codebase, not of this package, so `reason` is any string — pin it to a union of your own
to turn it into a review gate:

```ts
type RawSqlReason =
	| "user-authored-sql" // the SQL came from a user; there is no AST to build
	| "empty-result-stub" // a constant zero-row result reading no table
	| "test-fixture" // a test asserting executor behaviour on synthetic SQL

const rawQuery = <Output>(args: {
	sql: string
	tenantScope: CH.TenantScope
	reason: RawSqlReason
	note: string
	rowSchema?: Schema.Schema<Output>
}) => CH.unsafeCompiledQuery<Output>(args)
```

Adding a member to that union is then the review gate — a one-line diff in one file that a
reviewer cannot miss. Leave out a `"legacy"` or `"todo"` member: with one, the gate is
decorative.
If your query doesn't fit a member, the answer is almost always to express it in the builder.

Supply a `rowSchema` too: handwritten SQL is exactly where schema drift goes unnoticed, and
without one `decodeRows` validates nothing. See [Decoding results](./decoding-results.md).

_(Backed by `docs/extending.md > unsafeCompiledQuery wraps handwritten SQL`.)_

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
