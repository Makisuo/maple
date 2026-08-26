# Documentation

`@maple-dev/clickhouse-builder` builds ClickHouse SQL from typed TypeScript. You describe a
table once, and the builder infers column types, output row shapes, and join accessors from
it. Queries are immutable values — every method returns a new query — and nothing touches the
network: the end product is a `CompiledQuery` holding a SQL string plus a typed decoder. You
bring your own ClickHouse client.

Every code block in these guides is backed by a test in
[`src/docs-examples.test.ts`](../src/docs-examples.test.ts), which compiles the query and
asserts the emitted SQL.

## Guides

Roughly in reading order.

| Guide                                                 | What it covers                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| [Getting started](./getting-started.md)               | Install, define a table, build → compile → decode                        |
| [Tables and column types](./tables-and-types.md)      | `table()`, the column-type constructors, `Map`/`Array`/`Nullable`        |
| [Building queries](./queries.md)                      | `select`, `where`, `groupBy`, `orderBy`, `limit`, `format`, immutability |
| [Expressions and conditions](./expressions.md)        | Comparisons, arithmetic, optional predicates, aggregates                 |
| [Joins and subqueries](./joins-and-subqueries.md)     | The join family, `fromQuery`, correlated subqueries                      |
| [Unions and CTEs](./unions-and-ctes.md)               | `unionAll`, `fromUnion`, `withCTE`                                       |
| [Params and compilation](./params-and-compilation.md) | `param.*`, how values reach the SQL, `CompiledQuery`                     |
| [Decoding results](./decoding-results.md)             | `rowSchema`, `decodeRows`, `decodeFirstRow`, decode errors               |
| [Tenant scoping](./tenant-scoping.md)                 | `tenantScope`, what marks a query scoped, `crossTenant()`                   |
| [Extending the DSL](./extending.md)                   | `defineFn`, raw escape hatches, handwritten SQL                          |

## Reference

- [API reference](./reference.md) — the full export catalog by module, plus error types.

## Entry points

| Import                                | Contents                                                                                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@maple-dev/clickhouse-builder`       | Curated public API — `from`, `compile`, `param`, expression helpers, and ClickHouse functions under friendly names (`min`, `max`, `count`, `quantile`, …) |
| `@maple-dev/clickhouse-builder/types` | Column-type constructors (`string`, `uint64`, `dateTime`, `map`, `array`, `nullable`, …) and the `CH*` type descriptors                                   |
| `@maple-dev/clickhouse-builder/expr`  | Kitchen-sink namespace: every expression helper plus all ClickHouse functions under their raw names (`min_`, `toString_`, `dynamicColumn`, `not`, …)      |
| `@maple-dev/clickhouse-builder/sql`   | The low-level `SqlFragment` AST (`raw`, `ident`, `compile`, …) for hand-rolling fragments                                                                 |

The root barrel is curated, not exhaustive — see
[the reference](./reference.md#whats-only-on-a-subpath) for what lives only on a subpath.
