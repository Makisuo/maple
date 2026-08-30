/**
 * Migration 0022 — a real p95 for service-map edges.
 *
 * The map's database nodes showed `max(Duration)` under a "p95" label. That is
 * not a rounding difference: a ScyllaDB node read 3s beside its own detail
 * panel's 7ms p95, because the panel merges a t-digest and the node could only
 * report the window's slowest single call. Renaming the field (the previous
 * commit) stopped the lie; this migration supplies the statistic people
 * actually want.
 *
 * `DurationQuantiles` is the SAME state type, weight expression and source
 * predicate that `service_map_db_query_shapes_hourly_mv` has computed since it
 * shipped — over a GROUP BY that is a strict superset of these two (it adds
 * `QueryKey`). Both new digests are therefore strictly FEWER digests than one
 * MV already builds on every insert, off identical rows. The write cost is a
 * fraction of what is already paid; a state is bounded (~800 B at a hundred
 * spans, ~7.4 KB at twenty million, growing logarithmically) and these tables
 * are one row per (org, hour, service, target, env); the read is one
 * `quantilesTDigestWeightedMerge` over the rows the query already scans.
 *
 * NOTHING IS BACKFILLED, and the gap is asymmetric on purpose. These tables keep
 * 365 days; raw `traces` keeps 30. A backfill could repair at most a twelfth of
 * the retained window, so buckets sealed before this migration keep an empty
 * state that merges to nothing. The read path reports 0 and the UI falls back to
 * `maxDurationMs` — labelled as a max, never as a p95. Recent windows get a real
 * p95 immediately regardless, because the splice reads the partial boundary
 * hours from raw spans and computes the digest there.
 *
 * `requiredForIngest: false` — both tables are MV-populated, the Rust gateway
 * writes neither, and bumping `clickHouseSchemaVersion` would un-ready ingest
 * routing for every BYO-ClickHouse org over a read-path improvement.
 *
 * MV bodies are frozen copies of the snapshot as of this migration, not rendered
 * from `latestSnapshotStatements` — see the note on migration 0019 for why a
 * delta migration must describe one step in history.
 */
export const migration_0022_service_map_edge_quantiles = {
	version: 22,
	description:
		"Add sample-weighted t-digest columns to the service-map db/external edge rollups so edges report a real p95 instead of a max",
	requiredForIngest: false,
	statements: [
		"ALTER TABLE service_map_db_edges_hourly ADD COLUMN IF NOT EXISTS DurationQuantiles AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32)",
		"ALTER TABLE service_external_edges_hourly ADD COLUMN IF NOT EXISTS DurationQuantiles AggregateFunction(quantilesTDigestWeighted(0.5, 0.95), UInt64, UInt32)",
		"DROP VIEW IF EXISTS service_map_db_edges_hourly_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_map_db_edges_hourly_mv TO service_map_db_edges_hourly AS\nSELECT\n          OrgId,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          ServiceName,\n          coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) AS DbSystem,\n          if(match(coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name']), '^([0-9a-fA-F]{32}|.*[.]hyperdrive[.]local)$'), 'hyperdrive', coalesce(nullIf(SpanAttributes['db.namespace'], ''), nullIf(SpanAttributes['db.name'], ''), nullIf(SpanAttributes['server.address'], ''), SpanAttributes['net.peer.name'])) AS DbNamespace,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          count() AS CallCount,\n          countIf(StatusCode = 'Error') AS ErrorCount,\n          sum(Duration / 1000000) AS DurationSumMs,\n          max(Duration / 1000000) AS MaxDurationMs,\n          countIf(TraceState LIKE '%th:%') AS SampledSpanCount,\n          countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS UnsampledSpanCount,\n          sum(SampleRate) AS SampleRateSum,\n          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS DurationQuantiles\n        FROM traces\n        WHERE SpanKind IN ('Client', 'Producer')\n          AND coalesce(nullIf(SpanAttributes['db.system.name'], ''), SpanAttributes['db.system']) != ''\n          AND ServiceName != ''\n        GROUP BY OrgId, Hour, ServiceName, DbSystem, DbNamespace, DeploymentEnv",
		"DROP VIEW IF EXISTS service_external_edges_hourly_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_external_edges_hourly_mv TO service_external_edges_hourly AS\nSELECT\n          OrgId,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          ServiceName,\n          multiIf(\n            coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != '', 'messaging',\n            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '', 'rpc',\n            'http'\n          ) AS TargetType,\n          multiIf(\n            coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != '', SpanAttributes['messaging.system'],\n            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '', SpanAttributes['rpc.system'],\n            ''\n          ) AS TargetSystem,\n          multiIf(\n            coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '' OR SpanAttributes['messaging.system'] != '',\n              if(coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != '', coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']), SpanAttributes['messaging.system']),\n            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '',\n              if(SpanAttributes['rpc.service'] != '', SpanAttributes['rpc.service'], SpanAttributes['rpc.system']),\n            if(SpanAttributes['server.address'] != '',\n              SpanAttributes['server.address'],\n              if(SpanAttributes['http.host'] != '',\n                SpanAttributes['http.host'],\n                SpanAttributes['url.authority']))\n          ) AS TargetName,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          count() AS CallCount,\n          countIf(StatusCode = 'Error') AS ErrorCount,\n          sum(Duration / 1000000) AS DurationSumMs,\n          max(Duration / 1000000) AS MaxDurationMs,\n          sum(SampleRate) AS SampleRateSum,\n          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS DurationQuantiles\n        FROM traces\n        WHERE SpanKind IN ('Client', 'Producer')\n          AND SpanAttributes['db.system.name'] = ''\n          AND ServiceName != ''\n          AND (\n               SpanAttributes['server.address'] != ''\n            OR SpanAttributes['http.host'] != ''\n            OR SpanAttributes['url.authority'] != ''\n            OR coalesce(nullIf(SpanAttributes['messaging.destination.name'], ''), SpanAttributes['messaging.destination']) != ''\n            OR SpanAttributes['messaging.system'] != ''\n            OR SpanAttributes['rpc.service'] != ''\n            OR SpanAttributes['rpc.system'] != ''\n          )\n        GROUP BY OrgId, Hour, ServiceName, TargetType, TargetSystem, TargetName, DeploymentEnv\n        HAVING TargetName != ''",
	],
} as const
