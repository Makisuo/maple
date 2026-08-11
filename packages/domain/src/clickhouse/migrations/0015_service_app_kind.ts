/**
 * Migration 0015 — app-kind signals on `service_platforms_hourly`.
 *
 * `service_platforms_hourly` already answers "where does this service run"
 * (k8s / cloudflare / lambda). It could not answer "what kind of app is this",
 * because the only signal it carried for that was `maple.sdk.type` — present
 * solely on services instrumented with a Maple SDK. A customer on vanilla OTel
 * browser JS was indistinguishable from a backend, which matters because the
 * service-detail Apdex threshold is derived from the app kind: 500 ms is a
 * backend target and scores a browser app as permanently frustrated.
 *
 * The three added columns are the vendor-neutral markers:
 *   - `telemetry.sdk.language` — `webjs` is the OTel browser SDK; `swift` /
 *     `kotlin` the mobile ones.
 *   - `browser.platform` — per OTel semconv, only ever set in a browser.
 *   - `device.type` — the mobile-side counterpart.
 *
 * Every column on this table is `SimpleAggregateFunction(max, String)`, where
 * empty sorts first, so a non-empty value from any span in the hour wins the
 * merge — "did *any* span carry this attribute", which is the question the
 * classifier asks.
 *
 * **No backfill.** The obvious one is safe (`max` is idempotent, so
 * re-inserting a group merges cleanly) but pointless: the classifier reads
 * `max()` across the viewed window, so a single hour of post-migration traffic
 * classifies the service correctly for every window that includes it. Services
 * read `unknown` for at most one hour, and `unknown` already falls back to the
 * 500 ms default — the behaviour it has today. A backfill would also have to
 * insert `SpanCount = 0` to avoid double-counting the one `sum` column on the
 * table, which is a sharp edge with nothing on the other side of it.
 *
 * `requiredForIngest: false`: nothing on the ingest path changes shape.
 * `service_platforms_hourly` is filled by a materialized view, never by a
 * native INSERT, so a BYO cluster still running the old view keeps ingesting
 * correctly — it simply leaves the three new columns empty, which classifies
 * its services exactly as they classify today. Gating ingest on this would
 * route every BYO org back to managed over a display-only classification.
 */
export const migration_0015_service_app_kind = {
	version: 15,
	description:
		"Add telemetry.sdk.language / browser.platform / device.type app-kind signals to service_platforms_hourly",
	statements: [
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS TelemetrySdkLanguage SimpleAggregateFunction(max, String) AFTER ProcessRuntimeName",
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS BrowserPlatform SimpleAggregateFunction(max, String) AFTER TelemetrySdkLanguage",
		"ALTER TABLE service_platforms_hourly ADD COLUMN IF NOT EXISTS DeviceType SimpleAggregateFunction(max, String) AFTER BrowserPlatform",
		"DROP VIEW IF EXISTS service_platforms_hourly_mv",
		`CREATE MATERIALIZED VIEW IF NOT EXISTS service_platforms_hourly_mv TO service_platforms_hourly AS
SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          max(ResourceAttributes['k8s.cluster.name']) AS K8sCluster,
          max(ResourceAttributes['k8s.pod.name']) AS K8sPodName,
          max(ResourceAttributes['k8s.deployment.name']) AS K8sDeploymentName,
          max(ResourceAttributes['k8s.statefulset.name']) AS K8sStatefulSetName,
          max(ResourceAttributes['k8s.daemonset.name']) AS K8sDaemonSetName,
          max(ResourceAttributes['k8s.namespace.name']) AS K8sNamespaceName,
          max(ResourceAttributes['cloud.platform']) AS CloudPlatform,
          max(ResourceAttributes['cloud.provider']) AS CloudProvider,
          max(ResourceAttributes['faas.name']) AS FaasName,
          max(ResourceAttributes['maple.sdk.type']) AS MapleSdkType,
          max(ResourceAttributes['process.runtime.name']) AS ProcessRuntimeName,
          max(ResourceAttributes['telemetry.sdk.language']) AS TelemetrySdkLanguage,
          max(ResourceAttributes['browser.platform']) AS BrowserPlatform,
          max(ResourceAttributes['device.type']) AS DeviceType,
          count() AS SpanCount
        FROM traces
        WHERE ServiceName != ''
        GROUP BY OrgId, Hour, ServiceName, DeploymentEnv`,
	],
	requiredForIngest: false,
} as const
