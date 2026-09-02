/**
 * Migration 0023 — tell endpoints apart from everything else that looks like one.
 *
 * `service_operations_*` key on the normalized operation name, which for HTTP is
 * built from `http.route` and falls back to `url.path`. Three separate facts are
 * lost in that one string, and the API tab was guessing at all three from the
 * text:
 *
 *   1. An OUTBOUND call named `GET` with a `url.path` attribute normalizes to
 *      exactly the same `GET /path` an endpoint does, so a service's own calls to
 *      other people appear as endpoints it serves. Measured on the internal org
 *      over 24h: 406 such Client spans against 114,335 Server spans.
 *   2. A route template and a raw URL are indistinguishable, so `/v2/orgs/{id}`
 *      and `/v2/orgs/8f3ad9…` are the same kind of row. A service without
 *      `http.route` produces one "endpoint" per id — `maple-landing` has 12,940
 *      over 30 days — which is enough to swallow the whole list.
 *   3. Because of (2) the read cap is spent on rows the UI then collapses, so a
 *      high-cardinality service shows no endpoints at all.
 *
 * MEASURES, NOT DIMENSIONS. The obvious shape is `SpanKind`/`HasRoute` in the
 * GROUP BY, and it is the wrong one: a new dimension has to join the sorting key,
 * and until it does an AggregatingMergeTree merges rows that differ only in that
 * column and sums straight across the distinction you added it to make. Changing
 * a sorting key is also a Tinybird datasource migration with a forward query
 * rather than an ALTER. Counting the spans instead answers the same questions,
 * keeps the grain, the cardinality and the sorting key byte-identical, and is a
 * pure additive ALTER — the same trade migration 0022 made.
 *
 * `ClassifiedSpanCount` is the coverage marker and is what makes this safe to
 * read immediately. Only the post-0023 MV writes it, so a bucket holding 0 for it
 * predates the migration and its two siblings mean UNKNOWN rather than NONE. A
 * read that forgets this distinction empties every historical window the moment
 * it ships, because rows sealed last month honestly contain zero server spans.
 *
 * NOTHING IS BACKFILLED, and the gap is deliberate: these tables keep 90 and 365
 * days against raw `traces`' 30, so a backfill could repair at most a third of the
 * shorter window and a twelfth of the longer one. Recent windows are correct
 * immediately regardless, because the splice reads its boundary buckets from raw
 * spans and computes the counters there.
 *
 * `requiredForIngest: false` — both tables are MV-populated, the Rust gateway
 * writes neither, and bumping `clickHouseSchemaVersion` would un-ready ingest
 * routing for every BYO-ClickHouse org over a read-path improvement.
 *
 * MV bodies are frozen copies of the snapshot as of this migration, not rendered
 * from `latestSnapshotStatements` — see the note on migration 0019 for why a
 * delta migration must describe one step in history.
 */
export const migration_0023_service_operations_discriminators = {
	version: 23,
	description:
		"Count server and routed spans per service operation so endpoints can be told apart from outbound calls and raw URL paths",
	requiredForIngest: false,
	statements: [
		"ALTER TABLE service_operations_minutely ADD COLUMN IF NOT EXISTS ClassifiedSpanCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_minutely ADD COLUMN IF NOT EXISTS ServerSpanCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_minutely ADD COLUMN IF NOT EXISTS RoutedSpanCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_hourly ADD COLUMN IF NOT EXISTS ClassifiedSpanCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_hourly ADD COLUMN IF NOT EXISTS ServerSpanCount SimpleAggregateFunction(sum, UInt64)",
		"ALTER TABLE service_operations_hourly ADD COLUMN IF NOT EXISTS RoutedSpanCount SimpleAggregateFunction(sum, UInt64)",
		"DROP VIEW IF EXISTS service_operations_minutely_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_operations_minutely_mv TO service_operations_minutely AS\nSELECT\n          OrgId,\n          toStartOfMinute(toDateTime(Timestamp)) AS Minute,\n          ServiceName,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          if(((SpanName LIKE 'http.server %' OR SpanName IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')) AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != '')), concat(if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName), ' ', if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])), SpanName) AS SpanName,\n          count() AS SpanCount,\n          sum(SampleRate) AS EstimatedSpanCount,\n          countIf(StatusCode = 'Error') AS ErrorCount,\n          sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,\n          sum(toFloat64(Duration)) AS DurationSum,\n          quantilesTDigestState(0.5, 0.95)(Duration) AS DurationQuantiles,\n          count() AS ClassifiedSpanCount,\n          countIf(SpanKind IN ('Server', 'Consumer')) AS ServerSpanCount,\n          countIf(SpanAttributes['http.route'] != '') AS RoutedSpanCount\n        FROM traces\n        GROUP BY OrgId, Minute, ServiceName, DeploymentEnv, SpanName",
		"DROP VIEW IF EXISTS service_operations_hourly_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_operations_hourly_mv TO service_operations_hourly AS\nSELECT\n  OrgId,\n  toStartOfHour(Minute) AS Hour,\n  ServiceName,\n  DeploymentEnv,\n  SpanName,\n  sum(SpanCount) AS SpanCount,\n  sum(EstimatedSpanCount) AS EstimatedSpanCount,\n  sum(ErrorCount) AS ErrorCount,\n  sum(EstimatedErrorCount) AS EstimatedErrorCount,\n  sum(DurationSum) AS DurationSum,\n  quantilesTDigestMergeState(0.5, 0.95)(DurationQuantiles) AS DurationQuantiles,\n  sum(ClassifiedSpanCount) AS ClassifiedSpanCount,\n  sum(ServerSpanCount) AS ServerSpanCount,\n  sum(RoutedSpanCount) AS RoutedSpanCount\nFROM service_operations_minutely\nGROUP BY OrgId, Hour, ServiceName, DeploymentEnv, SpanName",
	],
} as const
