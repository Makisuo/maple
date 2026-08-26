# API reference

Everything on this page is exported from the root entry point
(`@maple-dev/clickhouse-builder`) unless marked otherwise.

## Naming conventions

Some ClickHouse functions collide with JavaScript reserved words or globals. The source defines
those with a trailing underscore, and **the root barrel drops it**: `min_`, `max_`, `any_`,
`toString_`, `length_`, `left_`, `extract_`, `least_`, `greatest_`, `position_`, `lower_`,
`round_`, `path_` and `domain_` are all exported from the root under their bare names.

One exception, because it cannot be anything else:

| Root barrel name | Also on `/expr` as | Note                             |
| ---------------- | ------------------ | -------------------------------- |
| `if_`            | `if_`              | `if` is a reserved word          |
| `in_` / `notIn`  | —                  | `Expr` methods; `in` is reserved |

Importing the kitchen-sink namespace
(`import * as CH from "@maple-dev/clickhouse-builder/expr"`) gives you the raw underscored names
uniformly, which some codebases prefer for exactly this reason.

## What's only on a subpath

The root barrel is curated. These are exported by the package but not from it:

| Symbol                                                                                           | Subpath |
| ------------------------------------------------------------------------------------------------ | ------- |
| `toFragment` — value → `SqlFragment`, for hand-rolled function wrappers                          | `/expr` |
| `raw`, `str`, `ident`, `int`, `join`, `as_`, `lazy`, `when`, `compile`, `escapeClickHouseString` | `/sql`  |
| `SqlQuery`, `compileQuery`                                                                       | `/sql`  |
| `ClickHouseStatement`, `parseStatement`, `renderStatement`, `withSettings`, `withFormat`         | `/sql`  |
| `ClickHouseStatementFromString`, `splitTerminalClauses`, `maskLiteralsAndComments`               | `/sql`  |

Every column-type constructor and every expression helper is on the root as well as on its
subpath. See [Running a query](./running-queries.md) for what the `/sql` statement helpers are
for.

Note `/sql` exports a `compile` (fragment → string) distinct from the root `compile`
(query → `CompiledQuery`), and a `when` distinct from the root `when` (optional conditions).

---

## Entry points

### Query construction

| Export      | Signature                                 |
| ----------- | ----------------------------------------- |
| `table`     | `(name, columns, options?) => Table`      |
| `custom`    | `(sql, schema, literalSchema?) => CHType` |
| `from`      | `(table, alias?) => CHQuery`              |
| `fromQuery` | `(query, alias) => CHQuery`               |
| `fromUnion` | `(union, alias) => CHQuery`               |
| `unionAll`  | `(...queries) => CHUnionQuery`            |

### `CHQuery` methods

| Method                                                | Notes                                               |
| ----------------------------------------------------- | --------------------------------------------------- |
| `select(...names)` / `select(fn)`                     | Required before compiling                           |
| `where(fn)`                                           | Returns `Array<Condition \| undefined>`; AND-joined |
| `groupBy(...outputKeys)`                              | Takes select aliases, not column names              |
| `orderBy(...[col, dir])`                              | **Tuples**, not two strings                         |
| `limit(n)` / `offset(n)`                              | Rounded before emission                             |
| `format(fmt)`                                         | `"JSON"` \| `"JSONEachRow"`                         |
| `innerJoin` / `leftJoin` / `crossJoin`                | `(table, alias, on?)`                               |
| `innerJoinQuery` / `leftJoinQuery` / `crossJoinQuery` | `(query, alias, on?)`                               |
| `withCTE(name, sql, options?)`                        | `options.tenantScope`                               |
| `route("ingest")`                                     | Metadata only                                       |
| `crossTenant()`                                       | Forces `tenantScope: "cross-tenant"`                |

`CHUnionQuery` offers only `orderBy`, `limit`, `offset`, `format`.

### Compilation

| Export               | Signature                                                                       |
| -------------------- | ------------------------------------------------------------------------------- |
| `compile`            | `(query, params, options?) => Effect<CompiledQuery<Output>, QueryBuilderError>` |
| `compileUnsafe`      | The same, returning `CompiledQuery<Output>` and throwing instead                |
| `compileUnion`       | `(union, params, options?) => Effect<CompiledQuery<Output>, QueryBuilderError>` |
| `compileUnionUnsafe` | The same, throwing instead                                                      |
| `rawCompiledQuery`   | `({ sql, tenantScope, reason, note, rowSchema?, route? }) => CompiledQuery`     |

### Params

`param.string(name)`, `param.int(name)`, `param.float(name)`, `param.bool(name)`,
`param.dateTime(name)`, `param.dateTimeString(name)`, and `param.of(type, name)` for any column
type. Each checks the value it is handed at compile
time; see [Params and compilation](./params-and-compilation.md#what-each-kind-accepts).

---

## Expressions

| Export                    | Purpose                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `lit(value)`              | Literal `Expr` from a `string` or `number`                 |
| `rawExpr(sql, type)`      | Unescaped `Expr` from SQL text, with a declared type       |
| `untypedExpr<T>(sql)`     | Unescaped `Expr` with no type — costs the row schema       |
| `rawCond(sql)`            | Unescaped `Condition` from SQL text                        |
| `when(value, fn)`         | `Condition \| undefined`; skips `undefined`/`null`/`false` |
| `whenTrue(flag, fn)`      | Boolean-gated variant                                      |
| `inList(expr, values)`    | `expr IN ('a', 'b')`                                       |
| `inExprList(expr, exprs)` | Same for expression lists                                  |
| `notInList(expr, values)` | `expr NOT IN ('a', 'b')`                                   |
| `not(condition)`          | `NOT (…)`                                                  |
| `dynamicColumn(name, t?)` | An `Expr` from a runtime column name — a `GROUP BY` alias  |
| `exists(q)`               | `EXISTS (…)` from a query or pre-compiled SQL              |
| `inSubquery(expr, q)`     | `expr IN (…)` from a query or pre-compiled SQL             |
| `notInSubquery(expr, q)`  | `expr NOT IN (…)`; note the NULL semantics                 |
| `outerRef<T>(name)`       | Reference an outer column in a correlated subquery         |

`Expr<T>` methods: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in_`, `notIn`, `like`, `notLike`,
`ilike` (string-only), and `add`, `sub`, `mul`, `div`, `mod` (number-only, **no parentheses**). `div` and `mod` decode
nullably — ClickHouse sends `inf`/`nan` as JSON `null`; guard with `ifNotFinite`.

### Spliced sub-SELECTs

For SQL the builder has no syntax for — an inner query's text inside an aggregate or a tuple
comparison. The inner query is compiled by the **outer** `compile`, so its params resolve from the
outer set and its failures land in the outer error channel. See
[Joins and subqueries](./joins-and-subqueries.md#splicing-a-subquery-where-there-is-no-syntax-for-one).

| Export                             | Purpose                                   |
| ---------------------------------- | ----------------------------------------- |
| `subqueryExpr(q, type, wrap?)`     | Inner SQL as an `Expr` of a declared type |
| `untypedSubqueryExpr<T>(q, wrap?)` | Same with no type — costs the row schema  |
| `subqueryCond(q, wrap)`            | Inner SQL as a `Condition`                |

`wrap` receives the inner SQL and returns the text to emit. It defaults to wrapping the SQL in
parentheses, which is the plain "this value is a sub-SELECT" case.

`Condition` methods: `and`, `or` (both parenthesise; both drop the tenant marker).

`ColumnRef` adds `.get(key)` for `Map` columns; the result decodes as the map's value type.

## Extensibility

| Export                                 | Purpose                                            |
| -------------------------------------- | -------------------------------------------------- |
| `defineFn<Args, R>(name, result)`      | Declare a standard `fn(args…)` returning `Expr<R>` |
| `defineUntypedFn<Args, R>(name)`       | Same, for a result with no type to declare         |
| `defineCondFn<Args>(name)`             | Same, returning `Condition`                        |
| `sameAs(i)`                            | Result rule: decodes as argument `i`               |
| `firstTyped()`                         | Result rule: the first argument that has a type    |
| `firstTypedNonNull()`                  | Same, minus `\| null` — `coalesce`, `ifNull`       |
| `elementOf(i)`                         | Result rule: one element of argument `i`'s array   |
| `arrayOfArg(i)`                        | Result rule: an array of argument `i`              |
| `compileFnCall<R>(name, ...args)`      | Variadic/generic wrapper (untyped result)          |
| `compileTypedFnCall<R>(name, schema,)` | Same, with the result codec                        |
| `compileFnCallCond(name, ...args)`     | Same, returning `Condition`                        |
| `makeExpr<T>(fragment, schema)`        | Build an `Expr` from a fragment and its codec      |
| `makeUntypedExpr<T>(fragment)`         | Same with no codec — costs the row schema          |
| `makeCond(fragment)`                   | Build a `Condition` from a fragment                |
| `schemaOf(expr)`                       | An expression's codec, or `undefined`              |
| `schemaOfAny(...exprs)`                | The first codec among several                      |
| `elementSchema(expr)`                  | The element codec of an array expression           |
| `withoutNull(schema)`                  | A codec minus its `null` arm, or `undefined`       |
| `paramPlaceholder(kind, name)`         | The `__PARAM_…__` text, for handwritten fragments  |

---

## ClickHouse functions

### Aggregate

`count()`, `countIf(cond)`, `avg(e)`, `sum(e)`, `min(e)`, `max(e)`, `any(e)`, `uniq(e)`,
`sumIf(e, cond)`, `avgIf(e, cond)`, `minIf(e, cond)`, `maxIf(e, cond)`, `anyIf(e, cond)`,
`groupUniqArray(e)`, `groupUniqArrayIf(e, cond)`, `groupUniqArrayArray(e)`, `uniqIf(e, cond)`, `uniqExact(e)`,
`argMin(value, order)`, `argMax(value, order)`, `argMaxMerge(e)`, `quantile(q)(e)` _(curried)_,
`windowFunnel(window, mode?)(ts, ...conds)` and `sequenceMatch(pattern)(ts, ...conds)`
_(both curried; `WindowFunnelMode` is the mode union)_.

`min`/`max` return `Expr<NonNullable<T>>`; `groupUniqArray` returns `Expr<ReadonlyArray<T>>`.

### String

`toString(e)`, `length(e)`, `lower(e)`, `hex(e)`, `match(e, pattern)`, `matchCond(e, pattern)`
→ `Condition`, `domain(url)`, `path(url)`, `cutQueryString(url)`, `position(haystack, needle)`,
`positionCaseInsensitive(a, b)`, `left(e, n)`, `extract(e, pattern)`,
`replaceOne(haystack, pattern, replacement)`, `concat(...exprs)`, `hasToken(haystack, token)`,
`hasAllTokens(haystack, tokens)`.

`hasToken` and `hasAllTokens` return `Condition`.

### Numeric

`toFloat64(e)`, `toFloat64OrZero(e)`, `toUInt16OrZero(e)`, `toUInt64(e)`, `toInt64(e)`,
`intDiv(a, b)`, `round(e, decimals?)`, `least(...exprs)`, `greatest(...exprs)`,
`cityHash64(...exprs)`.

### Date/time

`toStartOfInterval(col, seconds)`, `toStartOfHour(col)`, `toUnixTimestamp(col)`,
`toUnixTimestamp64Nano(col)`, `intervalSub(col, seconds)`, `intervalAdd(col, seconds)`,
`formatDateTime(col, format)`, `toDateTime(col)`, `toStartOfMinute(col)`, `toHour(col)`.

### Conditional

`if_(cond, then, else)`, `multiIf([[cond, value], …], fallback)`, `coalesce(...exprs)`,
`nullIf(expr, value)`, `ifNotFinite(expr, fallback)` (`expr` unless it is `nan`/`inf` — the SQL-side
guard for division).

### Array

`arrayOf(...exprs)`, `arrayStringConcat(arr, sep)`, `arrayFilter(fn, arr)`, `arrayJoin(arr)`,
`arraySort(arr)`, `arrayReverseSort(arr)`, `arrayDistinct(arr)`, `arrayPushFront(arr, value)`,
`arrayElement(arr, index)`, `has(arr, value)` → `Condition`.

### Map

`mapContains(map, key)` → `Condition`, `mapGet(map, key)`, `mapKeys(map)`, `mapValues(map)`,
`mapLiteral(...[key, expr])`. Prefer `$.Column.get(key)` for a declared `Map` column.

### JSON

`toJSONString(e)`.

### Window

`over(expr, spec)`, `windowSpec({ partitionBy?, orderBy?, frame? })`,
`rowsBetween(start, end)`, `lagInFrame(expr, offset, defaultValue)` _(all three arguments
required)_, and the frame bounds `currentRow`, `unboundedPreceding`, `unboundedFollowing`,
`preceding(n)`, `following(n)`.

```ts
CH.over(
	CH.lagInFrame($.DurationMs, 1, 0),
	CH.windowSpec({
		partitionBy: [$.Name],
		orderBy: [[$.Timestamp, "asc"]],
		frame: CH.rowsBetween(CH.unboundedPreceding, CH.currentRow),
	}),
)
```

Types: `WindowSpec`, `CompiledWindowSpec`, `WindowFrameBound`, `WindowRowsFrame`,
`WindowOrderDirection`.

---

## Types

**Column-type constructors** — `string`, `bool`, `uint8`, `uint16`, `uint32`, `uint64`, `int32`,
`int64`, `float64`, `dateTime`, `dateTime64`, `dateTimeString`, `dateTime64String`, `map`,
`array`, `nullable`, `aggregateState(fn, ...args)`, `custom(sql, schema, literalSchema?)`, and
`untyped(sql)` for a wire value passed through unvalidated. See
[Tables and column types](./tables-and-types.md).

**Type descriptors** — `CHType`, `CHString`, `CHBool`, `CHUInt8`, `CHUInt16`, `CHUInt32`,
`CHUInt64`, `CHInt32`, `CHInt64`, `CHFloat64`, `CHDateTime`, `CHDateTime64`, `CHDateTimeString`,
`CHDateTime64String`, `CHMap`, `CHArray`, `CHNullable`.

**Inference** — `InferTS` (the decoded type of a column), `InferEncoded` (its wire type),
`InferOutput`, `InferQueryOutput`, `InferUnionOutput`, `OutputToColumnDefs`,
`NullableColumnDefs`, `ColumnDefs`.

**Everything else** — `Table`, `TableOptions`, `Expr`, `ColumnRef`, `Condition`, `Comparable`
(what a value of a type may be compared against), `MapValueOf`, `Subquery`, `ParamMarker`,
`ParamKind`, `CHQuery`, `CHUnionQuery`, `ColumnAccessor`, `JoinedColumnAccessor`,
`JoinOnCallback`, `CompiledQuery`, `CompiledQueryInput`, `CompiledQueryRowSchema`, `RowSchemaMismatch`, `TenantScope`, `FnResult`,
`WindowFunnelMode`, `WindowSpec`, `WindowRowsFrame`, `WindowFrameBound`,
`WindowOrderDirection`, `CompiledWindowSpec`.

## Errors

Both are Effect `Schema.TaggedError`s, catchable by tag.

### `QueryBuilderError`

Tag `"@maple-dev/clickhouse-builder/QueryBuilderError"`. Raised while compiling, and surfaced in
`compile`'s error channel (thrown by `compileUnsafe`).

| `code`             | Cause                                                                    |
| ------------------ | ------------------------------------------------------------------------ |
| `UnresolvedParam`  | A param the params bag has no value for                                  |
| `InvalidLiteral`   | A param value, or a comparison operand, the column's codec rejects       |
| `InvalidArguments` | Arguments a function cannot use — an empty condition list, a bad pattern |

### `QueryBuilderDefect`

Tag `"@maple-dev/clickhouse-builder/QueryBuilderDefect"`. A DSL misuse no runtime value can cause
— a query with no `select()`, an `orderBy` entry that is not a tuple, a bad param name, a
comparison called on a param marker, two column types claiming one ClickHouse type name. Always
a defect: `compile` maps only `QueryBuilderError` into the error channel. See
[Failures and defects](./params-and-compilation.md#failures-and-defects).

### `CompiledQueryEncodeError`

Tag `"@maple-dev/clickhouse-builder/CompiledQueryEncodeError"`. Fails the `encodeRows` Effect
when a decoded row cannot be written back to its wire shape. Fields: `message`, `rowIndex`,
`cause`.

### `CompiledQueryDecodeError`

Tag `"@maple-dev/clickhouse-builder/CompiledQueryDecodeError"`. Fails the `decodeRows` /
`decodeFirstRow` Effect. Fields: `message`, `rowIndex`, `cause`.
