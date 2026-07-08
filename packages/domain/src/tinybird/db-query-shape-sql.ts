/**
 * Shared SQL fragments for deriving a database query *shape* — a low-cardinality
 * label plus a normalized grouping key — from a span's OpenTelemetry attributes.
 *
 * These fragments are used in TWO places that MUST produce byte-identical SQL,
 * or the same query would be assigned different keys in the sealed hourly
 * rollup (`service_map_db_query_shapes_hourly_mv`) vs. the in-progress-hour raw
 * fallback in `@maple/query-engine`, and the two branches would fail to merge:
 *
 *   - write side: `service_map_db_query_shapes_hourly_mv` (this package)
 *   - read side:  `serviceDb*SQL` builders (packages/query-engine, raw branch)
 *
 * This file deliberately has NO imports (plain strings only) so pulling it into
 * the query-engine / web / cli bundles does not drag in the Tinybird SDK.
 *
 * OTEL database semantic-convention note: the query shape lives in *attributes*,
 * and a conformant DB-client span name already IS `db.query.summary`
 * (e.g. "SELECT users"). A generic span name like "execute" means the
 * instrumentation isn't following the spec — so `SpanName` is only ever a last
 * resort here, never the preferred shape.
 *
 * The fragments reference the raw `traces` columns `SpanAttributes`, `SpanName`
 * directly, so they're only valid in a scope where those columns are present.
 */

/** `db.system.name` (stable semconv) with `db.system` (legacy) fallback. */
export const DB_SYSTEM_ATTR_SQL =
	"coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system'])"

/**
 * Sentinel `db.namespace` value for a database reached through Cloudflare
 * Hyperdrive. Hyperdrive presents Postgres to the driver with its 32-char hex
 * config ID as the database name, and there is a *separate config per deployment
 * environment*, so the raw namespace explodes into one service-map node per
 * Worker/PR-preview binding — all fronting the same database. We collapse those
 * opaque IDs (see `OPAQUE_DB_NAMESPACE_RE`) to this single readable value; the UI
 * brands the node as "Hyperdrive". Kept in sync with the read-side collapse in
 * `@maple/query-engine` (`collapseHyperdriveNs`) and the frontend resolver.
 */
export const HYPERDRIVE_DB_NAMESPACE = "hyperdrive"

/**
 * Matches an *opaque* database namespace that should collapse to
 * `HYPERDRIVE_DB_NAMESPACE`: a bare 32-char hex string (a Cloudflare Hyperdrive
 * config ID) or a `*.hyperdrive.local` host (the `server.address`/`net.peer.name`
 * fallback). `[.]` matches a literal dot without a backslash, so the pattern
 * carries no escapes — it embeds byte-identically in both the raw SQL below and
 * the escaped DSL `match()` literal on the read side.
 */
export const OPAQUE_DB_NAMESPACE_RE = "^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$"

/** Raw identity coalesce: `db.namespace` → `db.name` → `server.address` → `net.peer.name`. */
const DB_NAMESPACE_COALESCE_SQL =
	"coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name'])"

/**
 * Best-available database identity disambiguator, by the semconv target-identity
 * order (`db.namespace` → `server.address`), each with its legacy spelling as
 * fallback (`db.name`, `net.peer.name`), then collapsed to `HYPERDRIVE_DB_NAMESPACE`
 * when it is an opaque Hyperdrive identifier. Empty when the instrumentation emits
 * none of them — those spans keep collapsing into the per-system generic node.
 *
 * MUST stay byte-identical to the compiled `collapseHyperdriveNs(dbNamespaceCoalesce)`
 * DSL on the read side (`packages/query-engine` service-map.ts) — see the header.
 */
export const DB_NAMESPACE_ATTR_SQL = `if(match(${DB_NAMESPACE_COALESCE_SQL}, '${OPAQUE_DB_NAMESPACE_RE}'), '${HYPERDRIVE_DB_NAMESPACE}', ${DB_NAMESPACE_COALESCE_SQL})`

/** Full query text: `db.query.text` (stable semconv) with `db.statement` (legacy) fallback. */
export const DB_STATEMENT_SQL =
	"coalesce(nullIf(SpanAttributes['db.query.text'], ''), SpanAttributes['db.statement'])"

/**
 * Wrap a statement-text expression in a normalization pipeline that produces a
 * stable shape signature: lowercase, strip string + numeric literals to `?`,
 * collapse `IN (...)` lists to `in (?)`, collapse whitespace, trim. Two
 * statements that differ only in literal values normalize identically.
 *
 * Patterns use `String.raw` so the source backslash count matches the
 * ClickHouse string-literal level 1:1 (CH then halves `\\` → `\` for RE2).
 * Verified against ClickHouse RE2.
 */
const normalizeStatementSql = (stmt: string): string =>
	String.raw`replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(lower(${stmt}), '\'[^\']*\'', '?'), '\\bin\\s*\\([^)]*\\)', 'in (?)'), '[0-9]+(\\.[0-9]+)?', '?'), '\\s+', ' '), '^\\s+|\\s+$', '')`

/**
 * A human-presentable form of a statement for use as the query-shape LABEL:
 * strip string + numeric literals to `?`, collapse `IN (...)` lists and
 * whitespace, but PRESERVE case (unlike `normalizeStatementSql`, which
 * lowercases for the grouping key). This is the shape made visible — it
 * distinguishes co-located shapes (e.g. several different SELECTs on the same
 * table) that a terse `{op} {table}` summary flattens into one indistinct row.
 * Driver-generic op names (e.g. db.operation.name="execute") make that summary
 * useless, so the read path prefers this whenever statement text exists.
 */
export const presentableStatementSql = (stmt: string): string =>
	String.raw`trimBoth(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(replaceRegexpAll(${stmt}, '\'[^\']*\'', '?'), '(?i)\\bin\\s*\\([^)]*\\)', 'IN (?)'), '[0-9]+(\\.[0-9]+)?', '?'), '\\s+', ' '))`

/**
 * Best-effort low-cardinality summary derived from raw statement text when the
 * instrumentation didn't emit `db.query.summary`: `{VERB} {first table}`
 * (e.g. "SELECT users", "UPDATE public.accounts"). Empty when no statement.
 *
 * `upper`, not `upperUTF8`: the input is an RE2 `\w+` capture (ASCII-only), so
 * the two are byte-identical here — and `upperUTF8` is ICU-gated since
 * ClickHouse 24.8, absent from the non-ICU libchdb that local mode embeds
 * (using it broke fresh `maple start` store bootstrap).
 */
const derivedStatementSummarySql = (stmt: string): string =>
	String.raw`if(${stmt} != '', trimBoth(concat(upper(extract(${stmt}, '^\\s*(\\w+)')), if(extract(${stmt}, '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)') != '', concat(' ', extract(${stmt}, '(?i)(?:from|into|update|join|table)\\s+\\W?([\\w.]+)')), ''))), '')`

/**
 * `{db.operation.name} {db.collection.name|db.namespace}` (e.g. "SELECT users",
 * "HSET cache") when `db.operation.name` is present, else empty. This is the
 * OTEL-recommended composition of `db.query.summary` from its parts.
 */
const DERIVED_OPERATION_SUMMARY_SQL = `if(SpanAttributes['db.operation.name'] != '', trimBoth(concat(SpanAttributes['db.operation.name'], if(coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace']) != '', concat(' ', coalesce(nullIf(SpanAttributes['db.collection.name'], ''), SpanAttributes['db.namespace'])), ''))), '')`

/**
 * The human-readable query shape label, by OTEL-attribute precedence:
 *   1. db.query.summary           — canonical low-cardinality shape
 *   2. {operation.name} {target}  — composed from operation + collection/namespace
 *   3. {VERB} {table}             — derived from raw statement text
 *   4. query.context              — Maple's own friendly warehouse-query label
 *   5. db.operation.name / db.operation
 *   6. SpanName                   — silent last resort (non-conformant naming)
 */
export const DB_QUERY_LABEL_SQL = `coalesce(
  nullIf(SpanAttributes['db.query.summary'], ''),
  nullIf(${DERIVED_OPERATION_SUMMARY_SQL}, ''),
  nullIf(${derivedStatementSummarySql(DB_STATEMENT_SQL)}, ''),
  nullIf(SpanAttributes['query.context'], ''),
  nullIf(SpanAttributes['db.operation.name'], ''),
  nullIf(SpanAttributes['db.operation'], ''),
  SpanName
)`

/**
 * The grouping key (a string), by precedence:
 *   1. db.query.fingerprint (legacy: db.statement.fingerprint) — when instrumentation provides it
 *   2. cityHash64(normalize(statement text))    — literal-normalized shape hash
 *   3. cityHash64(label)                         — already-low-cardinality fallback
 *
 * (2) is what stops `WHERE id = 1` / `WHERE id = 2` from fragmenting into
 * separate shapes when only inlined-literal statement text is available.
 */
export const DB_QUERY_KEY_SQL = `coalesce(
  nullIf(SpanAttributes['db.query.fingerprint'], ''),
  nullIf(SpanAttributes['db.statement.fingerprint'], ''),
  nullIf(if(${DB_STATEMENT_SQL} != '', toString(cityHash64(${normalizeStatementSql(DB_STATEMENT_SQL)})), ''), ''),
  toString(cityHash64(${DB_QUERY_LABEL_SQL}))
)`
