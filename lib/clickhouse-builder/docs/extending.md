# Extending the DSL

The wrapped function catalog is deliberately partial — it covers what gets used, not all of
ClickHouse. There are four escape hatches, in increasing order of how much they give up.

## `defineFn` — declare a missing function

One line for any standard `fn(args…)` function. You supply the argument tuple, the return type,
and the ClickHouse type it produces:

```ts
const toStartOfFiveMinute = CH.defineFn<[CH.Expr<string>], string>("toStartOfFiveMinute", T.dateTimeString)

CH.from(Events)
	.select(($) => ({ bucket: toStartOfFiveMinute($.Timestamp) }))
	.where(($) => [$.OrgId.eq("org_123")])
// toStartOfFiveMinute(Timestamp) AS bucket
```

Arguments are compiled through the same escaping path as everything else, so raw values are
safe to pass. This is the right tool almost every time.

The result type is **required**, and that is the whole point: row schemas are derived from the
SELECT and derivation is all-or-nothing, so one function that never declared its result costs
every query using it the ability to decode anything. `defineUntypedFn` says a result genuinely
has no type — use it only for values that never become a row.

_(Backed by `docs/extending.md > defineFn declares a missing function`.)_

### Results that depend on the arguments

Plenty of ClickHouse functions hand back one of their inputs rather than a fixed type. Pass a
rule instead of a type:

| Rule            | Meaning                                       | Example                     |
| --------------- | --------------------------------------------- | --------------------------- |
| `sameAs(i)`     | decodes as argument `i` does                  | `min`, `argMax`, `over`     |
| `firstTyped()`  | decodes as the first argument that has a type | `coalesce`, `if`            |
| `elementOf(i)`  | one element of argument `i`'s array           | `arrayJoin`, `arrayElement` |
| `arrayOfArg(i)` | an array of argument `i`                      | `groupUniqArray`            |

```ts
const anyLast = CH.defineFn<[CH.Expr<string>], string>("anyLast", CH.sameAs(0))
```

Any function of your own works: the rule is `(...args) => Schema.Codec | undefined`.

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

`rawExpr` and `rawCond` take a SQL string as-is. `rawExpr` still requires the column type its
SQL produces, so the row it lands in can still be decoded:

```ts
CH.from(Events)
	.select(($) => ({ odd: CH.rawExpr("DurationMs % 2", T.float64) }))
	.where(($) => [$.OrgId.eq("org_123"), CH.rawCond("Name GLOBAL IN (SELECT 1)")])
```

> Neither escapes nor validates the SQL, and the declared type is an assertion you are making
> about text the builder cannot read. **Never build one from user input.**

`untypedExpr(sql)` is the version for SQL whose result has no type to declare — a sort tuple
that is only ever an `argMin` tiebreaker, never a selected value. Selecting one costs the query
its row schema, so it is deliberately a separate name.

`dynamicColumn<T>(name, type?)` (on the `/expr` subpath) is the same idea for a column name only
known at runtime; pass the type where you know it.

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
