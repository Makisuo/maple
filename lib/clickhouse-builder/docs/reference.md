# API reference

Everything on this page is exported from the root entry point
(`@maple-dev/clickhouse-builder`) unless marked otherwise.

## Naming conventions

Some ClickHouse functions collide with JavaScript reserved words or globals. The source defines
those with a trailing underscore, and the root barrel renames **some but not all** of them:

| Root barrel name | Also on `/expr` as | Note                             |
| ---------------- | ------------------ | -------------------------------- |
| `min`            | `min_`             | renamed                          |
| `max`            | `max_`             | renamed                          |
| `any`            | `any_`             | renamed                          |
| `toString`       | `toString_`        | renamed                          |
| `position`       | `position_`        | renamed                          |
| `left`           | `left_`            | renamed                          |
| `length`         | `length_`          | renamed                          |
| `extract`        | `extract_`         | renamed                          |
| `least`          | `least_`           | renamed                          |
| `greatest`       | `greatest_`        | renamed                          |
| `if_`            | `if_`              | **not** renamed                  |
| `lower_`         | `lower_`           | **not** renamed                  |
| `round_`         | `round_`           | **not** renamed                  |
| `in_` / `notIn`  | —                  | `Expr` methods; `in` is reserved |

There is no rule to infer here — check the table. Importing the kitchen-sink namespace
(`import * as CH from "@maple-dev/clickhouse-builder/expr"`) gives you the raw names uniformly,
which some codebases prefer for exactly this reason.

## What's only on a subpath

The root barrel is curated. These are exported by the package but not from it:

| Symbol                                                                                   | Subpath  |
| ---------------------------------------------------------------------------------------- | -------- |
| `uint16`, `uint32`, `int32`, `bool`                                                      | `/types` |
| `not`, `notInList`, `dynamicColumn`                                                      | `/expr`  |
| `makeColumnRef`, `aliased`, `toFragment`                                                 | `/expr`  |
| `raw`, `str`, `ident`, `int`, `join`, `as_`, `when`, `compile`, `escapeClickHouseString` | `/sql`   |
| `SqlQuery`, `compileQuery`                                                               | `/sql`   |

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
| `routing("ingest")`                                   | Metadata only                                       |
| `crossTenant()`                                       | Forces `tenantScope: "cross-tenant"`                |

`CHUnionQuery` offers only `orderBy`, `limit`, `offset`, `format`.

### Compilation

| Export                  | Signature                                                                     |
| ----------------------- | ----------------------------------------------------------------------------- |
| `compile`             | `(query, params, options?) => Effect<CompiledQuery<Output>, QueryBuilderError>` |
| `compileUnsafe`       | The same, returning `CompiledQuery<Output>` and throwing instead                |
| `compileUnion`        | `(union, params, options?) => Effect<CompiledQuery<Output>, QueryBuilderError>` |
| `compileUnionUnsafe`  | The same, throwing instead                                                      |
| `unsafeCompiledQuery`   | `({ sql, tenantScope, reason, note, rowSchema?, routing? }) => CompiledQuery` |

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
| `exists(sql)`             | `EXISTS (…)` from pre-compiled SQL                         |
| `inSubquery(expr, sql)`   | `expr IN (…)` from pre-compiled SQL                        |
| `outerRef<T>(name)`       | Reference an outer column in a correlated subquery         |

`Expr<T>` methods: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in_`, `notIn`, `like`, `notLike`,
`ilike` (string-only), and `add`, `sub`, `mul`, `div` (number-only, **no parentheses**).

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
| `elementOf(i)`                         | Result rule: one element of argument `i`'s array   |
| `arrayOfArg(i)`                        | Result rule: an array of argument `i`              |
| `compileFnCall<R>(name, ...args)`      | Variadic/generic wrapper (untyped result)          |
| `compileTypedFnCall<R>(name, schema,)` | Same, with the result codec                        |
| `compileFnCallCond(name, ...args)`     | Same, returning `Condition`                        |
| `makeExpr<T>(fragment, schema?)`       | Build an `Expr` from a fragment                    |
| `makeCond(fragment)`                   | Build a `Condition` from a fragment                |

---

## ClickHouse functions

### Aggregate

`count()`, `countIf(cond)`, `avg(e)`, `sum(e)`, `min(e)`, `max(e)`, `any(e)`, `uniq(e)`,
`sumIf(e, cond)`, `avgIf(e, cond)`, `minIf(e, cond)`, `maxIf(e, cond)`, `anyIf(e, cond)`,
`groupUniqArray(e)`, `argMaxMerge(e)`, `quantile(q)(e)` _(curried)_.

`min`/`max` return `Expr<NonNullable<T>>`; `groupUniqArray` returns `Expr<ReadonlyArray<T>>`.

### String

`toString(e)`, `length(e)`, `lower_(e)`, `position(haystack, needle)`,
`positionCaseInsensitive(a, b)`, `left(e, n)`, `extract(e, pattern)`,
`replaceOne(haystack, pattern, replacement)`, `concat(...exprs)`, `hasToken(haystack, token)`,
`hasAllTokens(haystack, tokens)`.

`hasToken` and `hasAllTokens` return `Condition`.

### Numeric

`toFloat64(e)`, `toFloat64OrZero(e)`, `toUInt16OrZero(e)`, `toUInt64(e)`, `toInt64(e)`,
`intDiv(a, b)`, `round_(e, decimals?)`, `least(...exprs)`, `greatest(...exprs)`,
`cityHash64(...exprs)`.

### Date/time

`toStartOfInterval(col, seconds)`, `toStartOfHour(col)`, `toUnixTimestamp(col)`,
`toUnixTimestamp64Nano(col)`, `intervalSub(col, seconds)`, `intervalAdd(col, seconds)`,
`formatDateTime(col, format)`, `toDateTime(col)`. `toHour(col)` is on `/expr` only.

### Conditional

`if_(cond, then, else)`, `multiIf([[cond, value], …], fallback)`, `coalesce(...exprs)`,
`nullIf(expr, value)`.

### Array

`arrayOf(...exprs)`, `arrayStringConcat(arr, sep)`, `arrayFilter(fn, arr)`, `arrayJoin(arr)`,
`has(arr, value)` → `Condition`.

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

`CHType`, `CHString`, `CHUInt8`, `CHUInt64`, `CHFloat64`, `CHDateTime`, `CHDateTime64`,
`CHMap`, `CHArray`, `CHNullable`, `InferTS`, `ColumnDefs`, `OutputToColumnDefs`,
`NullableColumnDefs`, `Table`, `Expr`, `ColumnRef`, `Condition`, `ParamMarker`, `CHQuery`,
`CHUnionQuery`, `ColumnAccessor`, `JoinedColumnAccessor`, `JoinOnCallback`, `InferOutput`,
`InferQueryOutput`, `InferUnionOutput`, `CompiledQuery`, `CompiledQueryRowSchema`, `TenantScope`.

## Errors

Both are Effect `Schema.TaggedError`s, catchable by tag.

### `QueryBuilderError`

Tag `"@maple-dev/clickhouse-builder/QueryBuilderError"`. Raised while compiling, and surfaced in
`compile`'s error channel (thrown by `compileUnsafe`).

| `code`               | Cause                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `SelectRequired`     | Compiling a query with no `select()`                                     |
| `UnresolvedParam`    | A param the params bag has no value for                                  |
| `InvalidParamValue`  | A param value that is not what its kind accepts                          |
| `InvalidLiteral`     | A comparison operand the column's codec rejects                          |
| `InvalidOrderBySpec` | An `orderBy` entry that is not a `[column, direction]` tuple             |
| `InvalidArguments`   | Arguments a function cannot use — an empty condition list, a bad pattern |

### `QueryBuilderDefect`

Tag `"@maple-dev/clickhouse-builder/QueryBuilderDefect"`. A DSL misuse no runtime value can cause
— a bad param name, a comparison called on a param marker, two column types claiming one
ClickHouse type name. Always a defect: `compile` maps only `QueryBuilderError` into the error
channel. See [Failures and defects](./params-and-compilation.md#failures-and-defects).

### `CompiledQueryDecodeError`

Tag `"@maple-dev/clickhouse-builder/CompiledQueryDecodeError"`. Fails the `decodeRows` /
`decodeFirstRow` Effect. Fields: `message`, `rowIndex`, `cause`.
