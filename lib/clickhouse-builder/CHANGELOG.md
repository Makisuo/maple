# Changelog

## 0.1.0 — unreleased

First public release.

- Type-safe table definitions, immutable query builder, joins, subqueries,
  unions, and CTEs.
- Parameterised compilation: `param.string` / `int` / `float` / `bool` /
  `dateTime`. Values are checked against the declared kind at compile time — a
  param with no value, a `Date` where a string was declared, or a fraction where
  an integer was, throws `QueryBuilderError` instead of becoming SQL text.
- Optional per-table tenant scoping: declare `{ tenantColumn }` on a table and
  every compiled query reports whether it pinned a single tenant. Reported,
  never enforced; tables that declare nothing always compile `"cross-tenant"`.
- `routing(tag)` carries an opaque execution tag through to the compiled query
  as a type-level fact.
- Schema-first column types: `T.uint64` and friends are Effect `Schema`s, not
  phantom tags, so `compile` derives each query's row schema from its SELECT and
  `decodeRows` validates without a hand-written schema. `rowSchemaSource` says
  whether it was `"derived"`, `"declared"`, or `"none"` (some selected
  expression had no type to read). A declared schema still wins, and can narrow.
- Wire quirks modelled once in the types: 64-bit integers accept ClickHouse's
  quoted form and Tinybird's bare numbers; `T.dateTime` parses the tz-less
  `YYYY-MM-DD hh:mm:ss` shape as UTC into a `DateTime.Utc`, with
  `T.dateTimeString` for consumers that need the string exactly as sent.
- The encode direction of those same schemas writes every literal: comparing a
  column against a value encodes it through the column's type, so a `Map` writes
  as `map('k', 'v')`, an `Array` as `['a', 'b']`, a `Bool` as `1`/`0`, and a
  value the column cannot hold fails while the SQL is being built. Params
  resolve through the same path, and `param.of(type, name)` accepts any column
  type — including one declared with `T.custom(sql, schema)`.
- Schema-checked row decoding (`decodeRows` / `decodeFirstRow`). No `castRows`.
- Requires Effect 4 (`effect@rc`) as a peer dependency.
