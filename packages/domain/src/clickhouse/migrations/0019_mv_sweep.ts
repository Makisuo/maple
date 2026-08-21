/**
 * Migration 0019 — materialized-view sweep.
 *
 * Four independent corrections, batched into one migration because each one on
 * its own would cost a numbered ClickHouse migration AND a local-schema version
 * bump with a retained snapshot and a migration edge.
 *
 * 1. DROP `error_spans` + its MV. Zero readers: nothing in the query DSL ever
 *    called `from(ErrorSpans)`. It cost 220 MB / 7.4M rows of pure write-and-store,
 *    and `warehouse-catalog.ts` was still advertising it to LLM agents as "use
 *    this instead of `traces WHERE StatusCode = 'Error'`" — so `run_sql`
 *    agents were actively steered onto a table no product code reads.
 *
 * 2. DROP the three `Events*` columns from `trace_detail_spans`. Unused by all
 *    nine readers (span hierarchy/detail, trace list, span search, session trace
 *    summaries, and the two AI-session queries). Worth 1.19 GB of the table's
 *    79 GB — small, but the columns were dead weight on the largest MV we have.
 *    The exception-event unwrapping that DOES need them reads `traces`, not this
 *    table, so `error_events_mv` is unaffected.
 *
 * 3. Recreate the four `attribute_values_hourly` MVs with a cardinality bound.
 *    With `AttributeValue != ''` as their only filter the target had reached
 *    1.59 BILLION rows / 12.3 GB to serve an autocomplete dropdown read a couple
 *    hundred times a week. Measured against production, the new predicate drops
 *    93.6% of rows while dropping ZERO values for every canonical OTel key
 *    (`http.response.status_code`, `http.method`, `db.system`, `service.name`,
 *    `deployment.environment`, ...). See the note on
 *    `attributeValueCardinalityBound` for why the rules are what they are.
 *
 * 4. Recreate `span_metrics_calls_hourly_mv` matching `traces.span.metrics.calls`.
 *    This is a BUG FIX, not a cleanup: the MV filtered
 *    `MetricName IN ('span.metrics.calls', 'calls')`, but the collector emits the
 *    counter namespaced by its pipeline. The rollup therefore held 0 rows for its
 *    entire existence while ~880k rows / 2 days of the real counter flowed into
 *    `metrics_sum`, and every read fell back to the raw window-function scan the
 *    read path measures at ~7s p95.
 *
 * Statement ORDER is load-bearing: `DROP VIEW` always precedes `DROP TABLE`.
 * The inverse leaves an MV whose `TO` target no longer exists, and ClickHouse
 * fails every subsequent insert into the source table with `Code: 60 UNKNOWN_TABLE`
 * — i.e. it wedges ingest. `scripts/lint-clickhouse-schema.ts` enforces the same
 * invariant on the snapshot.
 *
 * MV bodies are frozen copies of the snapshot at the time this migration was
 * written, NOT re-read from `latestSnapshotStatements`. A delta migration has to
 * describe one step in history: if it rendered the live snapshot, a server at
 * version 18 would jump straight to a body containing changes from migrations it
 * has not applied yet.
 *
 * `requiredForIngest: false` — every table here is MV-populated, the Rust
 * gateway writes none of them, and bumping `clickHouseSchemaVersion` would
 * un-ready ingest routing for every BYO-ClickHouse org over a read-path change.
 */
export const migration_0019_mv_sweep = {
	version: 19,
	description:
		"Drop the unread error_spans table and trace_detail_spans event columns; bound attribute_values_hourly cardinality; fix the span-metrics calls rollup metric name",
	requiredForIngest: false,
	statements: [
		"DROP VIEW IF EXISTS error_spans_mv",
		"DROP TABLE IF EXISTS error_spans",
		"DROP VIEW IF EXISTS trace_detail_spans_mv",
		"ALTER TABLE trace_detail_spans DROP COLUMN IF EXISTS EventsTimestamp",
		"ALTER TABLE trace_detail_spans DROP COLUMN IF EXISTS EventsName",
		"ALTER TABLE trace_detail_spans DROP COLUMN IF EXISTS EventsAttributes",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS trace_detail_spans_mv TO trace_detail_spans AS\nSELECT\n          OrgId,\n          Timestamp,\n          TraceId,\n          SpanId,\n          ParentSpanId,\n          SpanName,\n          SpanKind,\n          ServiceName,\n          Duration,\n          StatusCode,\n          StatusMessage,\n          SpanAttributes,\n          ResourceAttributes\n        FROM traces",
		"DROP VIEW IF EXISTS log_attribute_values_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS log_attribute_values_mv TO attribute_values_hourly AS\nSELECT\n          OrgId,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          AttributeKey,\n          AttributeValue,\n          'log' AS AttributeScope,\n          count() AS UsageCount\n        FROM logs\n        ARRAY JOIN\n          mapKeys(LogAttributes) AS AttributeKey,\n          mapValues(LogAttributes) AS AttributeValue\n        WHERE AttributeValue != ''\n          AND length(AttributeValue) <= 128\n          AND NOT (length(AttributeValue) > 4 AND match(AttributeValue, '^[0-9]+([.][0-9]+)?$'))\n          AND NOT match(AttributeKey, '(_id|[.]id|Id|_ns)$')\n          AND AttributeKey NOT LIKE 'http.request.header.%'\n          AND AttributeKey NOT LIKE 'http.response.header.%'\n        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope",
		"DROP VIEW IF EXISTS metric_attribute_values_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS metric_attribute_values_mv TO attribute_values_hourly AS\nSELECT\n          OrgId,\n          toStartOfHour(toDateTime(TimeUnix)) AS Hour,\n          AttributeKey,\n          AttributeValue,\n          'metric' AS AttributeScope,\n          count() AS UsageCount\n        FROM metrics_sum\n        ARRAY JOIN\n          mapKeys(Attributes) AS AttributeKey,\n          mapValues(Attributes) AS AttributeValue\n        WHERE AttributeValue != ''\n          AND length(AttributeValue) <= 128\n          AND NOT (length(AttributeValue) > 4 AND match(AttributeValue, '^[0-9]+([.][0-9]+)?$'))\n          AND NOT match(AttributeKey, '(_id|[.]id|Id|_ns)$')\n          AND AttributeKey NOT LIKE 'http.request.header.%'\n          AND AttributeKey NOT LIKE 'http.response.header.%'\n        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope",
		"DROP VIEW IF EXISTS trace_span_attribute_values_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS trace_span_attribute_values_mv TO attribute_values_hourly AS\nSELECT\n          OrgId,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          AttributeKey,\n          AttributeValue,\n          'span' AS AttributeScope,\n          count() AS UsageCount\n        FROM traces\n        ARRAY JOIN\n          mapKeys(SpanAttributes) AS AttributeKey,\n          mapValues(SpanAttributes) AS AttributeValue\n        WHERE AttributeValue != ''\n          AND length(AttributeValue) <= 128\n          AND NOT (length(AttributeValue) > 4 AND match(AttributeValue, '^[0-9]+([.][0-9]+)?$'))\n          AND NOT match(AttributeKey, '(_id|[.]id|Id|_ns)$')\n          AND AttributeKey NOT LIKE 'http.request.header.%'\n          AND AttributeKey NOT LIKE 'http.response.header.%'\n        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope",
		"DROP VIEW IF EXISTS trace_resource_attribute_values_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS trace_resource_attribute_values_mv TO attribute_values_hourly AS\nSELECT\n          OrgId,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          AttributeKey,\n          AttributeValue,\n          'resource' AS AttributeScope,\n          count() AS UsageCount\n        FROM traces\n        ARRAY JOIN\n          mapKeys(ResourceAttributes) AS AttributeKey,\n          mapValues(ResourceAttributes) AS AttributeValue\n        WHERE AttributeValue != ''\n          AND length(AttributeValue) <= 128\n          AND NOT (length(AttributeValue) > 4 AND match(AttributeValue, '^[0-9]+([.][0-9]+)?$'))\n          AND NOT match(AttributeKey, '(_id|[.]id|Id|_ns)$')\n          AND AttributeKey NOT LIKE 'http.request.header.%'\n          AND AttributeKey NOT LIKE 'http.response.header.%'\n        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope",
		"DROP VIEW IF EXISTS span_metrics_calls_hourly_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS span_metrics_calls_hourly_mv TO span_metrics_calls_hourly AS\nSELECT\n          OrgId,\n          toStartOfHour(toDateTime(TimeUnix)) AS Hour,\n          ServiceName,\n          MetricName,\n          Attributes['span.kind'] AS SpanKind,\n          cityHash64(mapKeys(Attributes), mapValues(Attributes)) AS AttrFingerprint,\n          cityHash64(mapKeys(ResourceAttributes), mapValues(ResourceAttributes)) AS ResourceFingerprint,\n          StartTimeUnix,\n          argMaxState(Value, TimeUnix) AS LastValue\n        FROM metrics_sum\n        -- 'traces.span.metrics.calls' is the name the collector actually emits:\n        -- spanmetricsconnector output is namespaced by the pipeline it is attached\n        -- to. Without it this MV matched nothing and the target sat at 0 rows since\n        -- it was created, while ~880k rows / 2 days of the real counter flowed past\n        -- into metrics_sum and every read fell back to the raw window-function scan\n        -- (~7s p95 -- see queries/metrics.ts). Keep this list in sync with\n        -- SPAN_METRICS_CALLS_NAMES on the read side.\n        WHERE MetricName IN ('span.metrics.calls', 'calls', 'traces.span.metrics.calls') AND IsMonotonic\n        GROUP BY OrgId, Hour, ServiceName, MetricName, SpanKind, AttrFingerprint, ResourceFingerprint, StartTimeUnix",
	],
} as const
