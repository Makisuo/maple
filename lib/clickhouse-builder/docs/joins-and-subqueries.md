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

*(Backed by `docs/joins-and-subqueries.md > Joining a table`.)*

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
tenants' rows, so the outer stays `"org"` even with no WHERE of its own. See
[Tenant scoping](./tenant-scoping.md).

*(Backed by `docs/joins-and-subqueries.md > Subquery in FROM uses flat accessors` and
`> A scoped subquery keeps the outer query scoped`.)*

## Correlated subqueries

These take **pre-compiled SQL strings**, because the inner query is compiled separately:

- `exists(subquerySql)` → `EXISTS (…)`
- `inSubquery(expr, subquerySql)` → `expr IN (…)`
- `outerRef<T>(name)` — reference an outer column from inside the inner query, e.g.
  `outerRef("e.TraceId")`

```ts
const inner = CH.compile(
	CH.from(Events)
		.select(($) => ({ n: $.Name }))
		.where(($) => [$.OrgId.eq("org_123"), $.Name.eq(CH.outerRef("s.Name"))]),
	{},
)

CH.from(Services, "s")
	.select(($) => ({ team: $.Team }))
	.where(($) => [$.OrgId.eq("org_123"), CH.exists(inner.sql)])
```

Because the subquery arrives as a string, none of its structure — including its tenant scope —
is visible to the outer compile. Filter explicitly on both sides.

## Membership helpers

- `inList(expr, values)` — `expr IN ('a', 'b')` for a string list
- `inExprList(expr, exprs)` — same, for expression lists
- `notInList(expr, values)` — available from the `/expr` subpath

These predate `.in_()` and remain useful when you have an array in hand rather than varargs.
