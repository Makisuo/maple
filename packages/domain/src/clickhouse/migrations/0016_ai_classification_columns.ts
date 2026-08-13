/**
 * Migration 0016 — AI classification columns on `traces`.
 *
 * Each column is appended at the end of the table and carries a constant
 * DEFAULT, so the `ALTER` is metadata-only on ClickHouse and Tinybird alike and
 * existing parts read the default for free. No `MATERIALIZE COLUMN` is needed
 * for the same reason, and rows written before the classifier shipped stay
 * readable (`AiRulesVersion = 0`).
 *
 * Column contracts (mirrored in `datasources.ts`, keep them in sync):
 *   - `AiVendor` '' means "not classified as AI", not "unknown vendor".
 *   - `AiRulesVersion` 0 means the row predates classification; any non-zero
 *     value means the span was examined, including a non-AI verdict. This is the
 *     only way to distinguish "not AI" from "never looked at".
 *   - `AiSessionKeyState` is a frozen quality enum 0-6.
 *   - `AiSessionKeyHash` is `cityHash64(value)`, 0 unless state >= 5.
 *   - `AiRollupHour` is a receive-time-clamped rollup hour written by ingest,
 *     epoch 0 until the ingest stage lands.
 *
 * `requiredForIngest: true` (it was `false` while the columns had no producer).
 * The gateway now names all five in its INSERT column list, so a BYO cluster
 * missing them would reject every direct insert — `clickHouseSchemaVersion`
 * therefore has to become "16" so the routing gate catches that org first.
 *
 * What an unmigrated BYO org experiences: `fetch_ingest_key`'s
 * `SCHEMA_REVISION_COMPATIBLE_SQL` compares the org's stamped
 * `org_clickhouse_settings.schema_version` against this value numerically, so a
 * cluster still below 16 resolves `clickhouse_ready = false` and its traffic
 * routes to the managed pipeline instead of its own cluster. No data is lost and
 * no insert fails; the org silently falls back until `applySchema` stamps 16, at
 * which point routing returns on the next 30s cache TTL. This is the designed
 * mechanism, not a side effect — contrast migrations 0010/0014/0015, which
 * changed nothing the gateway writes and so stayed `requiredForIngest: false`.
 *
 * The two skip indexes are declared on the datasource as well — that is what
 * puts them on managed (Tinybird) orgs and freshly bootstrapped clusters; these
 * statements backfill clusters already at version 15. Deliberately no
 * `MATERIALIZE INDEX`: that is a mutation over the whole table, and the 30-day
 * TTL rolls every unindexed part out on its own.
 *
 * Both index types are ClickHouse 24.12-compatible. `set(0)` is unbounded on
 * purpose (the vendor allowlist is closed at ~30 values, and a capped set that
 * overflows silently degrades to always-match); `ScopeName` gets tokenbf_v1
 * rather than bloom_filter because the registry's scope matchers include prefix
 * rules.
 */
/**
 * The ALTER list itself, exported because it has a second execution site: the
 * CLI's local-store v5 -> v6 module runs exactly these statements against chDB
 * (`apps/cli/src/server/local-store-migrations/v5-to-v6-ai-classification-columns.ts`).
 * That store's `traces` already exists, so bootstrapping the v6 DDL is a no-op on
 * it and the columns and indexes arrive only through these ALTERs.
 *
 * One definition rather than two copies and a "keep these in sync" comment —
 * same reasoning as `SERVICE_AI_VENDORS_HOURLY_SELECT_SQL`, which 0017 and the
 * Tinybird materialization share. Retuning `idx_scope_name` here used to leave
 * every migrated local store on the old index with nothing failing, because
 * v5 -> v6's `verify` compares against the *frozen* v6 manifest, which records
 * the index by name and not by parameters.
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
