/**
 * Migration 0023 — `ai_trace_index`, the Agent Sessions detection surface.
 *
 * Detecting agent traces by `mapContains(SpanAttributes, 'maple_ai.vendor.id')`
 * on raw `traces` cannot be indexed at production shape: GenAI spans are ~0.01%
 * of rows but arrive continuously — about one per index granule — so the
 * `mapKeys(SpanAttributes)` bloom prunes nothing and the scan reads the fat Map
 * column for every span in the window. Measured 2026-08-29 against production:
 * ~3.6s for a one-hour window, dead at the gateway's 15s kill by a day, and the
 * Agent Sessions page wants 30.
 *
 * `ai_trace_index` is a filtered projection (the `error_events` shape): only
 * the vendor-stamped spans, with the `maple_ai.*` identity pre-extracted to
 * plain columns. Roughly 10k narrow rows per day at current volume, against
 * 70M raw spans. `aiSessionListQuery`'s detection subquery and
 * `aiSessionFacetsQuery` read it; the per-trace fan-out still reads
 * `trace_detail_spans`, which is where every other fact about an agent span
 * (its status, its failure attributes, its vendor version) is read from.
 *
 * NOTHING IS BACKFILLED here: a materialized view sees inserts from creation
 * forward, so windows predating this migration under-report until the raw
 * table's 30-day TTL ages the gap out (agent tracing shipped 2026-08-20, so
 * the gap is small and shrinking).
 *
 * `requiredForIngest: false` — nothing writes `ai_trace_index` directly; the
 * gateway keeps writing `traces` and the view fans out inside ClickHouse.
 * Gating ingest on it would un-ready every BYO-ClickHouse org for a read-path
 * addition.
 *
 * The CREATE statements below are the verbatim DDL as the schema emitter
 * produced it at v23. Frozen history: never re-derive it from a later snapshot.
 */
export const migration_0023_ai_trace_index = {
	version: 23,
	description:
		"Create ai_trace_index + ai_trace_index_mv: filtered projection of GenAI agent spans for Agent Sessions detection and facets",
	requiredForIngest: false,
	statements: [
		"CREATE TABLE IF NOT EXISTS ai_trace_index (\n    OrgId LowCardinality(String),\n    Timestamp DateTime64(9),\n    TraceId String,\n    SessionId String,\n    VendorId LowCardinality(String),\n    ServiceName LowCardinality(String)\n)\nENGINE = MergeTree\nPARTITION BY toDate(Timestamp)\nORDER BY (OrgId, Timestamp, TraceId)\nTTL toDate(Timestamp) + INTERVAL 30 DAY",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS ai_trace_index_mv TO ai_trace_index AS\nSELECT\n          OrgId,\n          Timestamp,\n          TraceId,\n          SpanAttributes['maple_ai.session.id'] AS SessionId,\n          SpanAttributes['maple_ai.vendor.id'] AS VendorId,\n          ServiceName\n        FROM traces\n        WHERE SpanAttributes['maple_ai.vendor.id'] != ''",
	],
} as const
