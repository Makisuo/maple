import { attrItemsExpr, BODY_TOKEN_INDEX_EXPR } from "../../tinybird/index-exprs"

/**
 * Migration 0005 — full-text body index + attribute skip indexes.
 *
 * Adds ClickStack-style data-skipping indexes (see "Making ClickStack 5x
 * faster"):
 *
 *   - `logs.idx_body_tokens` — `tokenbf_v1` over `lower(Body)` so the query
 *     engine's `hasToken(lower(Body), <token>)` pre-filter prunes granules
 *     ahead of the substring `Body ILIKE '%…%'`.
 *   - `logs.idx_log_*` — bloom filters over `LogAttributes`/`ResourceAttributes`
 *     keys and values, mirroring the ones `traces` already has.
 *   - `traces.idx_*_attr_items` — bloom filters over the concatenated
 *     `key=value` "Items" expression so attribute-equality filters prune via
 *     `has(<items>, 'k=v')`.
 *
 * The index expressions are imported from the same {@link attrItemsExpr} /
 * {@link BODY_TOKEN_INDEX_EXPR} helpers the datasource definitions and the
 * query-engine predicates use — the three must stay byte-for-byte identical or
 * ClickHouse silently stops applying the index.
 *
 * Deliberately **no `MATERIALIZE INDEX`**: materializing over an existing
 * multi-billion-row part set exceeds the Cloudflare Worker subrequest budget
 * (same reason migration 0004 adds its `set` index without materializing). The
 * indexes apply to new parts immediately; with the 30-day TTL the whole table
 * is covered within a retention cycle as old parts roll off. An operator who
 * wants immediate coverage can run, partition by partition:
 *
 *   ALTER TABLE logs   MATERIALIZE INDEX idx_body_tokens  IN PARTITION '<date>'
 *   ALTER TABLE traces MATERIALIZE INDEX idx_span_attr_items IN PARTITION '<date>'
 *
 * All statements are `IF NOT EXISTS`, so they're no-ops on a fresh instance
 * whose migration-0001 snapshot already created the indexes at CREATE TABLE.
 */
export const migration_0005_body_and_attr_indexes = {
	version: 5,
	description:
		"Add tokenbf body index + logs attribute blooms + traces attribute 'items' blooms for search/filter granule pruning",
	statements: [
		`ALTER TABLE logs ADD INDEX IF NOT EXISTS idx_body_tokens ${BODY_TOKEN_INDEX_EXPR} TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1`,
		"ALTER TABLE logs ADD INDEX IF NOT EXISTS idx_log_attr_keys mapKeys(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1",
		"ALTER TABLE logs ADD INDEX IF NOT EXISTS idx_log_attr_vals mapValues(LogAttributes) TYPE bloom_filter(0.01) GRANULARITY 1",
		"ALTER TABLE logs ADD INDEX IF NOT EXISTS idx_log_resource_attr_keys mapKeys(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1",
		"ALTER TABLE logs ADD INDEX IF NOT EXISTS idx_log_resource_attr_vals mapValues(ResourceAttributes) TYPE bloom_filter(0.01) GRANULARITY 1",
		`ALTER TABLE traces ADD INDEX IF NOT EXISTS idx_span_attr_items ${attrItemsExpr("SpanAttributes")} TYPE bloom_filter(0.01) GRANULARITY 1`,
		`ALTER TABLE traces ADD INDEX IF NOT EXISTS idx_resource_attr_items ${attrItemsExpr("ResourceAttributes")} TYPE bloom_filter(0.01) GRANULARITY 1`,
	],
} as const
