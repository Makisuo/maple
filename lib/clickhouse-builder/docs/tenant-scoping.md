# Tenant scoping

Every compiled query carries a `tenantScope`:

```ts
compiled.tenantScope // "org" | "cross-org"
```

`"org"` means the query pins itself to a single tenant. `"cross-org"` means it reads whatever
the credentials can see. The builder only *computes and reports* this — it never blocks a
query. The intended use is that your executor refuses `"cross-org"` on its ordinary read path,
so a forgotten tenant filter fails loudly instead of quietly returning another tenant's rows.

> **Read this page before relying on the field.** It answers a narrow question precisely, and
> silently answers `"cross-org"` for everything outside that narrowness.

## What marks a query scoped

A query is `"org"` when either:

1. Its **top-level `where` list** contains an `eq` or `in_` on the tenant column, or
2. Every row source it reads — the `FROM` and each join — is already scoped.

```ts
CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])
// tenantScope: "org"
```

*(Backed by `docs/tenant-scoping.md > An OrgId equality scopes the query`.)*

## The tenant column is `OrgId`, and that is hardcoded

The marker is set only for a column named exactly **`OrgId`** (`TENANT_COLUMN` in
`src/ch/expr.ts`). There is currently no way to configure it.

```ts
const Tenanted = CH.table("tenanted", { tenant_id: T.string, Name: T.string })

CH.from(Tenanted)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.tenant_id.eq("org_123")])
// tenantScope: "cross-org"  ← despite being perfectly well filtered
```

So if your schema names the column anything else, **every** query reports `"cross-org"` and the
field carries no signal for you. Conversely, a column named `OrgId` that is not actually a
tenant key will mark queries as scoped when they are not. Know which case you are in before
building an authorization decision on top of this.

*(Backed by `docs/tenant-scoping.md > A column named anything else does not scope`.)*

## Only `eq` and `in_` count

```ts
$.OrgId.eq("org_123")        // scopes
$.OrgId.in_("org_a", "org_b") // scopes
$.OrgId.neq("org_123")       // does NOT scope
$.OrgId.like("org_%")        // does NOT scope
```

`!=` and `LIKE` on the tenant column narrow nothing meaningful, and treating them as scoping
would be worse than useless.

*(Backed by `docs/tenant-scoping.md > in_ also scopes; neq does not`.)*

## The marker does not survive `and` / `or`

```ts
.where(($) => [$.OrgId.eq("org_123").or($.Name.eq("checkout"))])
// tenantScope: "cross-org"
```

This is the bug the marker exists to catch: `OrgId = x OR anything` matches rows from other
tenants. Composition drops the marker deliberately, and it applies to `.and()` too — so keep
tenant predicates as their own top-level entry in the `where` array rather than folding them
into a compound condition.

*(Backed by `docs/tenant-scoping.md > The marker does not survive or()`.)*

## Inherited scope

A query reading only from scoped sources is itself scoped, even with no `where` of its own:

```ts
const inner = CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])

CH.fromQuery(inner, "sub").select(($) => ({ name: $.name }))
// tenantScope: "org"
```

For joins, **every** joined source must be scoped — one unscoped table drags the result to
`"cross-org"`. A CTE contributes only if the query's `FROM` names it *and* it was declared with
`{ tenantScope: "org" }`; see [Unions and CTEs](./unions-and-ctes.md#declare-the-ctes-scope).

## `crossOrg()` — the explicit opt-out

```ts
CH.from(Events)
	.select(($) => ({ name: $.Name }))
	.where(($) => [$.OrgId.eq("org_123")])
	.crossOrg()
// tenantScope: "cross-org"
```

`crossOrg()` forces `"cross-org"` regardless of the predicates, and it wins over everything
else. The point is to distinguish "this query deliberately spans tenants" from "someone forgot
the filter" — two states that are otherwise identical from the outside. Use it for admin and
internal-rollup queries so that reviewers, and your executor, can tell them apart.

*(Backed by `docs/tenant-scoping.md > crossOrg() is the explicit opt-out`.)*

## `routing("ingest")`

```ts
compiled.routing // "ingest" | undefined
```

`.routing("ingest")` is unrelated metadata that rides along on the compiled query. It changes
no SQL and means nothing on its own — it exists so a query definition can declare which
backend it must be read from, and an executor that understands the convention can honour it.
If you have no such executor, ignore it.

*(Backed by `docs/tenant-scoping.md > routing is carried onto the compiled query`.)*

## Handwritten SQL

`unsafeCompiledQuery` requires `tenantScope` explicitly, since a raw string cannot be
inspected. Whatever you pass is taken at face value.
