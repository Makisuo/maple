import type { ClickHouseMigration } from "./index"

/**
 * Migration 0025 — read the commit revision from `vcs.ref.head.revision`.
 *
 * The three service-overview views pre-extract `CommitSha` from
 * `ResourceAttributes`, and every one of them pinned `deployment.commit_sha` —
 * a key Maple invented before the semconv settled on `vcs.ref.head.revision`,
 * which is what `RES-05` in the setup audit tells people to set. Maple's own
 * SDKs dual-emitted both, which is why the gap never showed on our own
 * telemetry: a service instrumented to the semconv alone materialized an EMPTY
 * commit into every rollup, and the release timeline, the recent-deploys rail,
 * the commit facet and per-deploy comparisons all filter `CommitSha != ''` —
 * so that service had no deploys at all. Measured on the managed workspace over
 * one day: six orgs (17M spans) sent only the semconv key, two (1.2k spans)
 * only the vendor key.
 *
 * The vendor key is retired outright rather than coalesced: the SDKs stop
 * emitting it, the read side stops filtering on it, and all three bodies now
 * read `ResourceAttributes['vcs.ref.head.revision']` — the same expression the
 * commit filters on raw `traces` use, so a raw-table branch and a rollup
 * branch of the same window agree on every row.
 *
 * The bundled DDL is `CREATE ... IF NOT EXISTS` throughout, so each view is
 * dropped first or the old body simply survives. `CommitSha` is a GROUP BY key
 * of both rollups, so a service that emitted both keys with DIFFERENT values (a
 * version string under the vendor key, a SHA under the semconv one) keys its
 * post-migration buckets on the SHA; its pre-migration buckets keep the version.
 * That is one deploy reading as two around the migration instant, and it ages
 * out with the rollup TTL. A service that only ever sent the vendor key loses
 * its commit going forward until it sets `vcs.ref.head.revision`.
 *
 * Forward-only, same position as migration 0020: rows already materialized
 * keep what the old bodies wrote and converge as the targets' TTLs roll
 * (30d / 90d / 365d).
 *
 * `requiredForIngest: false` — every table here is MV-populated and the raw
 * insert path is unchanged, so a server mid-migration keeps ingesting.
 */
export const migration_0025_commit_sha_vcs_revision: ClickHouseMigration = {
	version: 25,
	description: "Pre-extract CommitSha from vcs.ref.head.revision; retire deployment.commit_sha",
	requiredForIngest: false,
	statements: [
		"DROP VIEW IF EXISTS service_overview_spans_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_overview_spans_mv TO service_overview_spans AS\nSELECT\n          OrgId,\n          toDateTime(Timestamp) AS Timestamp,\n          ServiceName,\n          Duration,\n          StatusCode,\n          TraceState,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          ResourceAttributes['vcs.ref.head.revision'] AS CommitSha,\n          SampleRate,\n          ResourceAttributes['service.namespace'] AS ServiceNamespace\n        FROM traces\n        WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''",
		"DROP VIEW IF EXISTS service_overview_hourly_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_overview_hourly_mv TO service_overview_hourly AS\nSELECT\n          OrgId,\n          toStartOfHour(toDateTime(Timestamp)) AS Hour,\n          ServiceName,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          ResourceAttributes['service.namespace'] AS ServiceNamespace,\n          ResourceAttributes['vcs.ref.head.revision'] AS CommitSha,\n          count() AS SpanCount,\n          sum(SampleRate) AS EstimatedSpanCount,\n          countIf(StatusCode = 'Error') AS ErrorCount,\n          sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,\n          sum(toFloat64(Duration)) AS DurationSum,\n          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationQuantiles,\n          min(toDateTime(Timestamp)) AS FirstSeen,\n          countIf(StatusCode != 'Error' AND Duration < 500000000) AS ApdexSatisfiedCount,\n          countIf(StatusCode != 'Error' AND Duration >= 500000000 AND Duration < 2000000000) AS ApdexToleratingCount\n        FROM traces\n        WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''\n        GROUP BY OrgId, Hour, ServiceName, DeploymentEnv, ServiceNamespace, CommitSha",
		"DROP VIEW IF EXISTS service_overview_minutely_mv",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS service_overview_minutely_mv TO service_overview_minutely AS\nSELECT\n          OrgId,\n          toStartOfMinute(toDateTime(Timestamp)) AS Minute,\n          ServiceName,\n          coalesce(nullIf(ResourceAttributes['deployment.environment.name'], ''), ResourceAttributes['deployment.environment']) AS DeploymentEnv,\n          ResourceAttributes['service.namespace'] AS ServiceNamespace,\n          ResourceAttributes['vcs.ref.head.revision'] AS CommitSha,\n          count() AS SpanCount,\n          sum(SampleRate) AS EstimatedSpanCount,\n          countIf(StatusCode = 'Error') AS ErrorCount,\n          sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,\n          sum(toFloat64(Duration)) AS DurationSum,\n          quantilesTDigestState(0.5, 0.95, 0.99)(Duration) AS DurationQuantiles,\n          min(toDateTime(Timestamp)) AS FirstSeen,\n          countIf(StatusCode != 'Error' AND Duration < 500000000) AS ApdexSatisfiedCount,\n          countIf(StatusCode != 'Error' AND Duration >= 500000000 AND Duration < 2000000000) AS ApdexToleratingCount\n        FROM traces\n        WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''\n        GROUP BY OrgId, Minute, ServiceName, DeploymentEnv, ServiceNamespace, CommitSha",
	],
} as const
