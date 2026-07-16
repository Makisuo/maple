// ---------------------------------------------------------------------------
// Shared skip-index expressions
//
// These SQL expression strings are used in TWO places that MUST stay byte-for-
// byte identical, otherwise the index silently stops applying:
//
//   1. The `expr` of a data-skipping INDEX on a datasource (datasources.ts) and
//      the equivalent `ALTER TABLE ... ADD INDEX` in a BYO-ClickHouse migration.
//   2. The query-engine predicate that references the same expression so
//      ClickHouse's index analysis recognizes it (e.g. `has(<attrItemsExpr>, …)`).
//
// Keep the single source here and import it on both sides.
// ---------------------------------------------------------------------------

/**
 * ClickStack "Items" expression: concatenates each map entry into a single
 * `key=value` string so an equality filter `Map['k'] = 'v'` can be pruned by a
 * `bloom_filter` skip index via `has(<items>, 'k=v')`.
 *
 * `mapKeys`/`mapValues` preserve element order, so `arrayMap` pairs them
 * correctly. Applied to `SpanAttributes` / `ResourceAttributes` on `traces`.
 */
export function attrItemsExpr(mapName: string): string {
	return `arrayMap((k, v) -> concat(k, '=', v), mapKeys(${mapName}), mapValues(${mapName}))`
}

/**
 * Body full-text token index expression. The index is on `lower(Body)` so a
 * case-insensitive `hasToken(lower(Body), '<lowercased-token>')` pre-filter can
 * prune granules ahead of the substring `ILIKE` (see the query engine's
 * `body-search.ts`).
 */
export const BODY_TOKEN_INDEX_EXPR = "lower(Body)"
