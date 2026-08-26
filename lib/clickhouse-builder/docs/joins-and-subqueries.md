# Joins and subqueries

## Joining a table

Each join takes the table, an alias, and an ON callback receiving both sides:

```ts
const query = CH.from(Events, "e")
	.innerJoin(Services, "s", (main, joined) => main.Name.eq(joined.Name))
	.select(($) => ({ name: $.Name, team: $.s.Team }))
	.where(($) => [$.OrgId.eq("org_123")])

// SELECT e.Name AS name, s.Team AS team
// FROM events AS e
// INNER JOIN services AS s ON e.Name = s.Name
// WHERE e.OrgId = 'org_123'
```

Once a join exists, the accessor gains a key per alias. Main-table columns stay at the top
level (`$.Name`), joined columns sit under their alias (`$.s.Team`). Alias the main table in
`from()` so its references qualify too.

Available: `innerJoin`, `leftJoin`, `crossJoin` (which takes no ON callback).

_(Backed by `docs/joins-and-subqueries.md > Joining a table`.)_

### `leftJoin` nullability

`leftJoin` wraps the joined side in `NullableColumnDefs`, so its columns infer as `T | null`
in the output row. That is the type system telling you the truth about an unmatched row —
handle it in your `rowSchema` rather than casting it away.

## Joining a subquery

`innerJoinQuery`, `leftJoinQuery`, and `crossJoinQuery` take a `CHQuery` instead of a table.
The inner query's **output** shape becomes the joined column set, so aliases you selected are
what you join on:

```ts
const perTeam = CH.from(Services)
	.select(($) => ({ name: $.Name, team: $.Team }))
	.where(($) => [$.OrgId.eq("org_123")])

CH.from(Events, "e")
	.innerJoinQuery(perTeam, "s", (main, joined) => main.Name.eq(joined.name))
	.select(($) => ({ team: $.s.team }))
```

## Subquery in `FROM`

`fromQuery(query, alias)` starts a new query over another query's output:

```ts
const inner = CH.from(Events)
	.select(($) => ({ name: $.Name, ms: $.DurationMs }))
	.where(($) => [$.OrgId.eq("org_123")])

const outer = CH.fromQuery(inner, "sub")
	.select(($) => ({ name: $.name, worst: CH.max($.ms) }))
	.groupBy("name")

// SELECT name AS name, max(ms) AS worst
// FROM (SELECT Name AS name, DurationMs AS ms FROM events WHERE OrgId = 'org_123') AS sub
// GROUP BY name
```

> **Accessors are flat.** Inside the outer query the inner columns are `$.name` and `$.ms` —
> **not** `$.sub.name`. The alias names the derived table in SQL; it does not namespace the
> accessor. Reaching for `$.sub.name` throws at runtime.

The outer query inherits the inner query's tenant scope: a scoped subquery cannot leak other
tenants' rows, so the outer stays `"tenant"` even with no WHERE of its own. See
[Tenant scoping](./tenant-scoping.md).

_(Backed by `docs/joins-and-subqueries.md > Subquery in FROM uses flat accessors` and
`> A scoped subquery keeps the outer query scoped`.)_

## Subquery conditions

- `inSubquery(expr, subquery)` → `expr IN (…)`
- `notInSubquery(expr, subquery)` → `expr NOT IN (…)`, i.e. an anti-join as a predicate
- `exists(subquery)` → `EXISTS (…)`
- `outerRef<T>(name)` — reference an outer column from inside the inner query, e.g.
  `outerRef("e.TraceId")`

Pass the **query itself**. It is compiled where it is spliced, so its params, table names and
column types stay checked:

```ts
const excluded = CH.from(Events)
	.select(($) => ({ n: $.Name }))
	.where(($) => [$.OrgId.eq(param.string("orgId"))])

const query = CH.from(Services, "s")
	.select(($) => ({ team: $.Team }))
	.where(($) => [$.OrgId.eq(param.string("orgId")), CH.notInSubquery($.Team, excluded)])

const compiled = yield * CH.compile(query, { orgId: "org_123" })
// … WHERE OrgId = 'org_123' AND Team NOT IN (SELECT Name AS n FROM events WHERE OrgId = 'org_123')
```

Params inside the subquery resolve from the **outer** param set: placeholders survive the splice
and are substituted in one pass at the end, so `orgId` above is passed once and reaches both.

For correlated subqueries, `outerRef` names a column of the enclosing query:

```ts
const inner = CH.from(Events)
	.select(($) => ({ n: $.Name }))
	.where(($) => [$.OrgId.eq("org_123"), $.Name.eq(CH.outerRef("s.Name"))])

CH.from(Services, "s")
	.select(($) => ({ team: $.Team }))
	.where(($) => [$.OrgId.eq("org_123"), CH.exists(inner)])
```

All three also accept a pre-compiled SQL string, for the rare case where that is all you have.

> **A subquery never scopes its outer query.** `WHERE x IN (SELECT y FROM t WHERE OrgId = 'a')`
> does not confine the outer read to org `a` — nothing stops org `b` holding the same `y`. The
> outer query still needs its own tenant predicate, or a row source that is itself scoped. This
> is true whether you pass a query or a string.

> **`NOT IN` and NULLs.** If the subquery yields any NULL, `NOT IN` is never true. Project a
> non-nullable column, or filter the NULLs out inside the subquery.

## Membership helpers

- `inList(expr, values)` — `expr IN ('a', 'b')` for a string list
- `inExprList(expr, exprs)` — same, for expression lists
- `notInList(expr, values)` — available from the `/expr` subpath

These predate `.in_()` and remain useful when you have an array in hand rather than varargs.
