# Unions and CTEs

## `unionAll`

`unionAll` combines queries that share an output shape. TypeScript enforces the shape match,
so a branch that selects different keys is a compile error.

```ts
const recent = CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123"), $.Timestamp.gte("2026-01-01 00:00:00")])

const archived = CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123"), $.Timestamp.lt("2026-01-01 00:00:00")])

const combined = CH.unionAll(recent, archived).orderBy(["name", "asc"]).limit(100)

const compiled = CH.compileUnion(combined, {})
// SELECT * FROM ( … UNION ALL … ) ORDER BY name ASC LIMIT 100
```

A `CHUnionQuery` is deliberately narrower than a `CHQuery` — it offers only `orderBy`, `limit`,
`offset`, and `format`. Those wrap the union in an outer `SELECT * FROM (…)`; the branches
themselves keep whatever ordering they declared.

Unions compile with **`compileUnion`**, not `compile`.

> **Watch branch types.** ClickHouse unifies column types across `UNION ALL` branches, and a
> branch pairing (say) a `Float64` with a `UInt64` can be rejected outright depending on server
> settings. Cast explicitly in each branch when the types are not already identical.

*(Backed by `docs/unions-and-ctes.md > unionAll with an outer ORDER BY`.)*

## `fromUnion`

To aggregate *across* a union, wrap it as the FROM source:

```ts
const outer = CH.fromUnion(combined, "branches")
	.select(($) => ({ name: $.name, total: CH.count() }))
	.groupBy("name")
```

Like [`fromQuery`](./joins-and-subqueries.md#subquery-in-from), accessors are flat (`$.name`),
and the outer query inherits the union's tenant scope — a union of scoped branches stays
scoped.

The classic use is stitching a sealed hourly rollup onto a live raw-table branch for the
in-progress hour, then re-aggregating over both.

## CTEs

`withCTE(name, sql, options?)` prepends a `WITH` clause. The body is a **pre-compiled SQL
string**, not a query object:

```ts
const Recent = CH.table("recent", { Name: T.string })
const cteSql = "SELECT Name FROM events WHERE OrgId = 'org_123'"

const query = CH.from(Recent)
	.withCTE("recent", cteSql, { tenantScope: "org" })
	.select(($) => ({ name: $.Name }))

// WITH recent AS ( SELECT Name FROM events WHERE OrgId = 'org_123' )
// SELECT Name AS name FROM recent
```

To *read* a CTE, declare a table whose name matches it and start the query there. That is what
gives you typed accessors over the CTE's columns — the builder cannot infer them from the
string.

*(Backed by `docs/unions-and-ctes.md > Selecting from a CTE`.)*

### Declare the CTE's scope

```ts
.withCTE("recent", cteSql, { tenantScope: "org" })
```

The body is opaque, so the builder cannot see the `OrgId` filter inside it. If the CTE is the
query's row source and you omit `tenantScope`, the compiled query reads as `"cross-org"` even
though its SQL is perfectly well filtered.

Two caveats worth internalising:

- The declaration is an **assertion you are making**, not something that gets verified. Passing
  `tenantScope: "org"` for a CTE that does not filter by tenant defeats the mechanism.
- It only takes effect when the query's `FROM` **names that CTE**. A CTE attached to a query
  that reads from a different table contributes nothing to the scope.

*(Backed by `docs/unions-and-ctes.md > A CTE needs its tenantScope declared`.)*

See [Tenant scoping](./tenant-scoping.md) for what `tenantScope` is for.
