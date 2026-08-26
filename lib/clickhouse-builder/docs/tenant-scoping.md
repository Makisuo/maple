# Tenant scoping

Every compiled query carries a `tenantScope`:

```ts
compiled.tenantScope // "single-tenant" | "cross-tenant" | "untenanted"
```

`"single-tenant"` means the query pins itself to one tenant. `"cross-tenant"` means it reads whatever
the credentials can see. The builder only _computes and reports_ this — it never blocks a
query. The intended use is that your executor refuses `"cross-tenant"` on its ordinary read path,
so a forgotten tenant filter fails loudly instead of quietly returning another tenant's rows.

> **Read this page before relying on the field.** It answers a narrow question precisely, and
> silently answers `"cross-tenant"` for everything outside that narrowness.

## Declare the tenant column

Row-per-tenant is the usual ClickHouse multi-tenancy shape, but whether a table has one — and
what the column is called — is a schema decision, so it is declared on the table:

```ts
const Events = CH.table(
	"events",
	{ OrgId: T.string, Name: T.string },
	{ tenantColumn: "OrgId" },
)
```

The option is checked against the column names you just declared, so a typo is a type error
rather than a query that silently never scopes. A table with **no** `tenantColumn` has nothing to
pin, and compiles to the third scope:

```ts
const Untenanted = CH.table("untenanted", { tenant_id: T.string, Name: T.string })

CH.from(Untenanted)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.tenant_id.eq("org_123")])
// tenantScope: "untenanted"  ← the column is not declared, so it does not scope
```

`"untenanted"` is not `"cross-tenant"`, and the difference is the point: "this table has no
row-level tenancy" and "this query reads every tenant's rows" are different facts, and an
executor that refuses the second should not refuse the first — otherwise every query over a
dimension or lookup table is refused.

The builder only says `"untenanted"` when it can see every source and none declares a tenant
column. Anything it cannot see into — a CTE handed to it as a SQL string, a subquery over a
table that does declare one — keeps the query at `"cross-tenant"`, so the unknown case is still
the refused one.

_(Backed by `docs/tenant-scoping.md > A table without a declared tenant column is untenanted`.)_

## What marks a query scoped

A query is `"single-tenant"` when either:

1. Its **top-level `where` list** contains an `eq` or `in_` on the declared tenant column, or
2. Every row source it reads — the `FROM` and each join — is already scoped.

```ts
CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])
// tenantScope: "single-tenant"
```

_(Backed by `docs/tenant-scoping.md > An OrgId equality scopes the query`.)_

Declaring a column that is not actually a tenant key will mark queries as scoped when they are
not — the builder takes the declaration at face value. Know which case you are in before building
an authorization decision on top of this.

## Only `eq` and `in_` count

```ts
$.OrgId.eq("org_123") // scopes
$.OrgId.in_("org_a", "org_b") // scopes
$.OrgId.neq("org_123") // does NOT scope
$.OrgId.like("org_%") // does NOT scope
```

`!=` and `LIKE` on the tenant column narrow nothing meaningful, and treating them as scoping
would be worse than useless.

_(Backed by `docs/tenant-scoping.md > in_ also scopes; neq does not`.)\_

## The marker does not survive `and` / `or`

```ts
.where(($) => [$.OrgId.eq("org_123").or($.Name.eq("checkout"))])
// tenantScope: "cross-tenant"
```

This is the bug the marker exists to catch: `OrgId = x OR anything` matches rows from other
tenants. Composition drops the marker deliberately, and it applies to `.and()` too — so keep
tenant predicates as their own top-level entry in the `where` array rather than folding them
into a compound condition.

_(Backed by `docs/tenant-scoping.md > The marker does not survive or()`.)_

## Inherited scope

A query reading only from scoped sources is itself scoped, even with no `where` of its own:

```ts
const inner = CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])

CH.fromQuery(inner, "sub").select(($) => ({ name: $.name }))
// tenantScope: "single-tenant"
```

For joins, **every** joined source must be scoped — one unscoped table drags the result to
`"cross-tenant"`. A CTE contributes only if the query's `FROM` names it _and_ it was declared with
`{ tenantScope: "single-tenant" }`; see [Unions and CTEs](./unions-and-ctes.md#declare-the-ctes-scope).

## `crossTenant()` — the explicit opt-out

```ts
CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])
	.crossTenant()
// tenantScope: "cross-tenant"
```

`crossTenant()` forces `"cross-tenant"` regardless of the predicates, and it wins over everything
else. The point is to distinguish "this query deliberately spans tenants" from "someone forgot
the filter" — two states that are otherwise identical from the outside. Use it for admin and
internal-rollup queries so that reviewers, and your executor, can tell them apart.

_(Backed by `docs/tenant-scoping.md > crossTenant() is the explicit opt-out`.)_

## `route(tag)`

```ts
const compiled = CH.compileUnsafe(CH.from(Events).select(…).route("archive"), params)
compiled.route // "archive"
```

`.route(tag)` is unrelated metadata that rides along on the compiled query, as a type-level
fact as well as a runtime one. The tag is any string you like: it changes no SQL and means
nothing on its own — it exists so a query definition can declare which backend it must be read
from, and an executor that understands your vocabulary can honour it. If you have no such
executor, ignore it.

_(Backed by `docs/tenant-scoping.md > route is carried onto the compiled query`.)_

## Handwritten SQL

`rawCompiledQuery` requires `tenantScope` explicitly, since a raw string cannot be
inspected. Whatever you pass is taken at face value — which is why it also requires a
`reason` and a `note` naming why the query isn't a builder query at all. See
[Extending](./extending.md#handwritten-queries-unsafecompiledquery).
