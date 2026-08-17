/**
 * Migration 0016 — AI classification columns on `traces`.
 *
 * Every column is appended last with a *constant* DEFAULT; that is what keeps the
 * `ALTER` metadata-only on ClickHouse and Tinybird and makes `MATERIALIZE COLUMN`
 * unnecessary. Do not introduce an expression DEFAULT here.
 *
 * Column contracts (mirrored in `datasources.ts`, keep them in sync):
 *   - `AiVendor` '' means "not classified as AI", not "unknown vendor".
 *   - `AiRulesVersion` 0 means the span was never examined (pre-rollout / flag
 *     off); any non-zero value means examined, including a non-AI verdict.
 *   - `AiSessionKeyState` is a frozen quality enum 0-6.
 *   - `AiSessionKeyHash` is `cityHash64(value)`, 0 unless state >= 5.
 *   - `AiRollupHour` is a receive-time-clamped rollup hour written by ingest.
 *
 * `requiredForIngest: true` because the gateway names all five in its INSERT
 * column list: a BYO cluster below schema version 16 resolves
 * `clickhouse_ready = false` in `fetch_ingest_key` and its traffic routes to the
 * managed pipeline until `applySchema` stamps 16 (routing returns on the next 30s
 * cache TTL). Nothing is lost and no insert fails — but the fallback is silent.
 *
 * The skip indexes are also declared on the datasource (that covers managed orgs
 * and fresh clusters); these statements backfill clusters already at 15.
 * Deliberately no `MATERIALIZE INDEX` — a whole-table mutation on `traces` is the
 * expensive mistake, and the 30-day TTL retires unindexed parts anyway.
 *
 * Both index types are ClickHouse 24.12-compatible. `set(0)` is unbounded on
 * purpose: a capped set that overflows silently degrades to always-match.
 * `ScopeName` uses tokenbf_v1 rather than bloom_filter because the registry's
 * scope matchers include prefix rules.
 */
/**
 * Shared with the CLI's local-store v5 -> v6 module, which runs exactly these
 * statements against chDB — one list, not two copies. Retuning an index here
 * silently leaves every migrated local store on the old one: v5 -> v6's `verify`
 * compares against the frozen v6 manifest, which records indexes by name, not by
 * parameters.
 */
export const AI_CLASSIFICATION_ALTER_STATEMENTS = [
	"ALTER TABLE traces ADD COLUMN IF NOT EXISTS AiVendor LowCardinality(String) DEFAULT ''",
	"ALTER TABLE traces ADD COLUMN IF NOT EXISTS AiSessionKeyState UInt8 DEFAULT 0",
	"ALTER TABLE traces ADD COLUMN IF NOT EXISTS AiSessionKeyHash UInt64 DEFAULT 0",
	"ALTER TABLE traces ADD COLUMN IF NOT EXISTS AiRulesVersion UInt32 DEFAULT 0",
	"ALTER TABLE traces ADD COLUMN IF NOT EXISTS AiRollupHour DateTime('UTC') DEFAULT toDateTime(0)",
	"ALTER TABLE traces ADD INDEX IF NOT EXISTS idx_ai_vendor AiVendor TYPE set(0) GRANULARITY 4",
	"ALTER TABLE traces ADD INDEX IF NOT EXISTS idx_scope_name ScopeName TYPE tokenbf_v1(4096, 3, 0) GRANULARITY 4",
] as const

export const migration_0016_ai_classification_columns = {
	version: 16,
	description: "Add AI classification columns and vendor/scope skip indexes to traces",
	requiredForIngest: true,
	statements: AI_CLASSIFICATION_ALTER_STATEMENTS,
} as const
