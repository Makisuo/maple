import { defineMaterializedView, node } from "@tinybirdco/sdk"
import {
	serviceUsage,
	serviceMapSpans,
	serviceMapChildren,
	serviceMapDbEdgesHourly,
	serviceMapDbQueryShapesHourly,
	serviceExternalEdgesHourly,
	servicePlatformsHourly,
	serviceOverviewSpans,
	errorSpans,
	errorEvents,
	errorEventsByTime,
	traceDetailSpans,
	traceListMv,
	attributeKeysHourly,
	attributeValuesHourly,
	tracesAggregatesHourly,
	logsAggregatesHourly,
	metricCatalog,
	spanMetricsCallsHourly,
} from "./datasources"
import {
	DB_NAMESPACE_ATTR_SQL,
	DB_QUERY_KEY_SQL,
	DB_QUERY_LABEL_SQL,
	DB_STATEMENT_SQL,
	DB_SYSTEM_ATTR_SQL,
} from "./db-query-shape-sql"

/**
 * Materialized view to aggregate log usage statistics per service per hour
 */
export const serviceUsageLogsMv = defineMaterializedView("service_usage_logs_mv", {
	description: "Materialized view to aggregate log usage statistics per service per hour",
	datasource: serviceUsage,
	nodes: [
		node({
			name: "service_usage_logs_mv_node",
			sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(TimestampTime) AS Hour,
          count() AS LogCount,
          sum(length(Body) + 200) AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM logs
        GROUP BY OrgId, ServiceName, Hour
      `,
		}),
	],
})

/**
 * Materialized view to aggregate trace/span usage statistics per service per hour
 */
export const serviceUsageTracesMv = defineMaterializedView("service_usage_traces_mv", {
	description: "Materialized view to aggregate trace/span usage statistics per service per hour",
	datasource: serviceUsage,
	nodes: [
		node({
			name: "service_usage_traces_mv_node",
			sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          count() AS TraceCount,
          sum(length(SpanName) + 300) AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM traces
        GROUP BY OrgId, ServiceName, Hour
      `,
		}),
	],
})

/**
 * Materialized view to aggregate sum metric usage statistics per service per hour
 */
export const serviceUsageMetricsSumMv = defineMaterializedView("service_usage_metrics_sum_mv", {
	description: "Materialized view to aggregate sum metric usage statistics per service per hour",
	datasource: serviceUsage,
	nodes: [
		node({
			name: "service_usage_metrics_sum_mv_node",
			sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          count() AS SumMetricCount,
          count() * 150 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM metrics_sum
        GROUP BY OrgId, ServiceName, Hour
      `,
		}),
	],
})

/**
 * Materialized view to aggregate gauge metric usage statistics per service per hour
 */
export const serviceUsageMetricsGaugeMv = defineMaterializedView("service_usage_metrics_gauge_mv", {
	description: "Materialized view to aggregate gauge metric usage statistics per service per hour",
	datasource: serviceUsage,
	nodes: [
		node({
			name: "service_usage_metrics_gauge_mv_node",
			sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          count() AS GaugeMetricCount,
          count() * 150 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM metrics_gauge
        GROUP BY OrgId, ServiceName, Hour
      `,
		}),
	],
})

/**
 * Materialized view to aggregate histogram metric usage statistics per service per hour
 */
export const serviceUsageMetricsHistogramMv = defineMaterializedView("service_usage_metrics_histogram_mv", {
	description: "Materialized view to aggregate histogram metric usage statistics per service per hour",
	datasource: serviceUsage,
	nodes: [
		node({
			name: "service_usage_metrics_histogram_mv_node",
			sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          count() AS HistogramMetricCount,
          count() * 250 AS HistogramMetricSizeBytes,
          0 AS ExpHistogramMetricCount,
          0 AS ExpHistogramMetricSizeBytes
        FROM metrics_histogram
        GROUP BY OrgId, ServiceName, Hour
      `,
		}),
	],
})

/**
 * Materialized view to aggregate exponential histogram metric usage statistics per service per hour
 */
export const serviceUsageMetricsExpHistogramMv = defineMaterializedView(
	"service_usage_metrics_exp_histogram_mv",
	{
		description:
			"Materialized view to aggregate exponential histogram metric usage statistics per service per hour",
		datasource: serviceUsage,
		nodes: [
			node({
				name: "service_usage_metrics_exp_histogram_mv_node",
				sql: `
        SELECT
          OrgId,
          ServiceName,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          0 AS LogCount,
          0 AS LogSizeBytes,
          0 AS TraceCount,
          0 AS TraceSizeBytes,
          0 AS SumMetricCount,
          0 AS SumMetricSizeBytes,
          0 AS GaugeMetricCount,
          0 AS GaugeMetricSizeBytes,
          0 AS HistogramMetricCount,
          0 AS HistogramMetricSizeBytes,
          count() AS ExpHistogramMetricCount,
          count() * 300 AS ExpHistogramMetricSizeBytes
        FROM metrics_exponential_histogram
        GROUP BY OrgId, ServiceName, Hour
      `,
			}),
		],
	},
)

/**
 * Materialized view projecting trace spans needed for service dependency map.
 * Extracts deployment.environment from Map columns at write time so the service
 * map JOIN query avoids scanning heavy Map columns.
 */
export const serviceMapSpansMv = defineMaterializedView("service_map_spans_mv", {
	description:
		"Materialized view projecting trace spans needed for service dependency map. Extracts deployment.environment from Map columns at write time.",
	datasource: serviceMapSpans,
	nodes: [
		node({
			name: "service_map_spans_mv_node",
			sql: `
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          TraceId,
          SpanId,
          ParentSpanId,
          ServiceName,
          SpanKind,
          Duration,
          StatusCode,
          TraceState,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv
        FROM traces
        WHERE SpanKind IN ('Client', 'Producer', 'Server', 'Consumer')
      `,
		}),
	],
})

/**
 * Materialized view projecting service entry point spans for service overview queries.
 * Includes Server/Consumer spans (service entry points per OTel semantics) plus root spans
 * as a fallback for services with Internal/unset SpanKind (cron jobs, workers).
 * Pre-extracts deployment.environment and deployment.commit_sha from ResourceAttributes
 * so the service overview query avoids scanning heavy Map columns.
 */
export const serviceOverviewSpansMv = defineMaterializedView("service_overview_spans_mv", {
	description:
		"Materialized view projecting service entry point spans (Server/Consumer + root) for service overview queries. Pre-extracts deployment attributes from ResourceAttributes at write time.",
	datasource: serviceOverviewSpans,
	nodes: [
		node({
			name: "service_overview_spans_mv_node",
			sql: `
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          ServiceName,
          Duration,
          StatusCode,
          TraceState,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          ResourceAttributes['deployment.commit_sha'] AS CommitSha,
          SampleRate,
          ResourceAttributes['service.namespace'] AS ServiceNamespace
        FROM traces
        WHERE SpanKind IN ('Server', 'Consumer') OR ParentSpanId = ''
      `,
		}),
	],
})

/**
 * Materialized view populating trace_list_mv from root spans.
 * Pre-extracts HTTP attributes from SpanAttributes and normalizes span names
 * so the trace list query avoids scanning heavy Map columns and GROUP BY.
 */
/**
 * Materialized view populating service_map_children from Server/Consumer spans.
 * Pre-filters to only spans with a parent and extracts deployment.environment
 * so the service map JOIN query scans far fewer rows on the child side.
 */
export const serviceMapChildrenMv = defineMaterializedView("service_map_children_mv", {
	description:
		"Populates service_map_children with Server/Consumer spans that have a parent for efficient JOIN lookups.",
	datasource: serviceMapChildren,
	nodes: [
		node({
			name: "service_map_children_mv_node",
			sql: `
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          TraceId,
          ParentSpanId,
          ServiceName,
          SpanKind,
          Duration,
          StatusCode,
          TraceState,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv
        FROM traces
        WHERE SpanKind IN ('Server', 'Consumer')
          AND ParentSpanId != ''
      `,
		}),
	],
})

// `service_map_edges_hourly` (service-to-service edges) is intentionally NOT
// populated by a materialized view. The downstream service name can only be
// recovered by joining a Client/Producer span to its child Server/Consumer
// span (modern OTEL instrumentation no longer emits a `peer.service`
// attribute) — a cross-span join that an *incremental* ClickHouse MV cannot
// express. The table is filled by the scheduled hourly rollup in
// `ServiceMapRollupService`, which runs that join once per completed hour.
//
// Why not a *refreshable* MV (`REFRESH EVERY 1 HOUR`), which can run a join?
//  - This schema deploys to both Tinybird and ClickHouse; Tinybird has no
//    refreshable-MV equivalent, so the rollup (routed via WarehouseQueryService)
//    is the only mechanism that works for both backends.
//  - Refreshable MVs are still experimental on the deployed ClickHouse (24.8).
//  - The job adds bounded-lookback catch-up + skip-existing idempotency that a
//    `REFRESH ... APPEND` MV does not provide.

/**
 * Materialized view pre-aggregating service-to-database edges per hour.
 * Aggregates Client/Producer spans with a database system set into hourly
 * buckets at write time so the database-node query reads pre-aggregated rows
 * instead of scanning raw span attributes.
 *
 * `DbSystem` uses the `db.system.name` → `db.system` coalesce (`DB_SYSTEM_ATTR_SQL`),
 * matching `service_map_db_query_shapes_hourly_mv`, so spans that emit only the
 * legacy `db.system` attribute are captured here too. `DbNamespace`
 * (`DB_NAMESPACE_ATTR_SQL`: `db.namespace` → `db.name` → `server.address` →
 * `net.peer.name`) splits distinct databases of the same system into distinct
 * service-map nodes; '' when the instrumentation identifies none.
 */
export const serviceMapDbEdgesHourlyMv = defineMaterializedView("service_map_db_edges_hourly_mv", {
	description:
		"Pre-aggregates Client/Producer spans with db.system.name into hourly service-to-database edge buckets for fast service map db-node queries.",
	datasource: serviceMapDbEdgesHourly,
	nodes: [
		node({
			name: "service_map_db_edges_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          ${DB_SYSTEM_ATTR_SQL} AS DbSystem,
          ${DB_NAMESPACE_ATTR_SQL} AS DbNamespace,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          count() AS CallCount,
          countIf(StatusCode = 'Error') AS ErrorCount,
          sum(Duration / 1000000) AS DurationSumMs,
          max(Duration / 1000000) AS MaxDurationMs,
          countIf(TraceState LIKE '%th:%') AS SampledSpanCount,
          countIf(TraceState = '' OR TraceState NOT LIKE '%th:%') AS UnsampledSpanCount,
          sum(SampleRate) AS SampleRateSum
        FROM traces
        WHERE SpanKind IN ('Client', 'Producer')
          AND ${DB_SYSTEM_ATTR_SQL} != ''
          AND ServiceName != ''
        GROUP BY OrgId, Hour, ServiceName, DbSystem, DbNamespace, DeploymentEnv
      `,
		}),
	],
})

/**
 * Materialized view pre-aggregating database *query shapes* per hour for the
 * service map's database detail panel. For each Client/Producer DB span it
 * derives a normalized shape key + readable label (see `db-query-shape-sql.ts`,
 * shared byte-for-byte with the query-engine read path's raw-fallback branch)
 * and rolls up call/error/sample counts plus a sample-weighted t-digest of
 * duration.
 *
 * NOTE: `DbSystem` uses the `db.system.name` → `db.system` coalesce
 * (`DB_SYSTEM_ATTR_SQL`), the same as `service_map_db_edges_hourly_mv`.
 */
export const serviceMapDbQueryShapesHourlyMv = defineMaterializedView(
	"service_map_db_query_shapes_hourly_mv",
	{
		description:
			"Pre-aggregates Client/Producer DB spans into hourly query-shape buckets (normalized fingerprint + label + sample-weighted t-digest) for the service map's database detail panel.",
		datasource: serviceMapDbQueryShapesHourly,
		nodes: [
			node({
				name: "service_map_db_query_shapes_hourly_mv_node",
				sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          ${DB_SYSTEM_ATTR_SQL} AS DbSystem,
          ${DB_NAMESPACE_ATTR_SQL} AS DbNamespace,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          ${DB_QUERY_KEY_SQL} AS QueryKey,
          any(substring(${DB_QUERY_LABEL_SQL}, 1, 220)) AS QueryLabel,
          any(substring(${DB_STATEMENT_SQL}, 1, 1000)) AS SampleStatement,
          count() AS CallCount,
          countIf(StatusCode = 'Error') AS ErrorCount,
          sum(SampleRate) AS EstimatedCount,
          sumIf(SampleRate, StatusCode = 'Error') AS EstimatedErrorCount,
          sum(toFloat64(Duration) * SampleRate / 1000000) AS WeightedDurationSumMs,
          quantilesTDigestWeightedState(0.5, 0.95)(Duration, toUInt32(greatest(SampleRate, 1.0))) AS DurationQuantiles
        FROM traces
        WHERE SpanKind IN ('Client', 'Producer')
          AND ${DB_SYSTEM_ATTR_SQL} != ''
          AND ServiceName != ''
        GROUP BY OrgId, Hour, ServiceName, DbSystem, DbNamespace, DeploymentEnv, QueryKey
      `,
			}),
		],
	},
)

/**
 * Materialized view pre-aggregating service-to-external-target edges per hour.
 * Captures Client/Producer spans WITHOUT `db.system.name` set (DB calls go to
 * `service_map_db_edges_hourly_mv`) — i.e. plain HTTP outbound, messaging
 * producers, and RPC clients.
 *
 * `TargetType` precedence: messaging > rpc > http. A span carrying both
 * `messaging.system` and `server.address` (rare, but happens when a queue
 * client also tags the broker address) lands as messaging — its identity is
 * the queue, not the host. RPC is preferred over http for the same reason.
 *
 * For HTTP the fallback chain for `TargetName` is
 * `server.address` → `http.host` → `url.authority` — modern OTel SDKs emit
 * `server.address`; legacy ones still emit `http.host`; some emit `url.authority`.
 */
export const serviceExternalEdgesHourlyMv = defineMaterializedView("service_external_edges_hourly_mv", {
	description:
		"Pre-aggregates Client/Producer spans without db.system.name into hourly service-to-external-target edges (http / messaging / rpc) for the service-detail Dependencies tab.",
	datasource: serviceExternalEdgesHourly,
	nodes: [
		node({
			name: "service_external_edges_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          multiIf(
            SpanAttributes['messaging.destination'] != '' OR SpanAttributes['messaging.system'] != '', 'messaging',
            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '', 'rpc',
            'http'
          ) AS TargetType,
          multiIf(
            SpanAttributes['messaging.destination'] != '' OR SpanAttributes['messaging.system'] != '', SpanAttributes['messaging.system'],
            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '', SpanAttributes['rpc.system'],
            ''
          ) AS TargetSystem,
          multiIf(
            SpanAttributes['messaging.destination'] != '' OR SpanAttributes['messaging.system'] != '',
              if(SpanAttributes['messaging.destination'] != '', SpanAttributes['messaging.destination'], SpanAttributes['messaging.system']),
            SpanAttributes['rpc.service'] != '' OR SpanAttributes['rpc.system'] != '',
              if(SpanAttributes['rpc.service'] != '', SpanAttributes['rpc.service'], SpanAttributes['rpc.system']),
            if(SpanAttributes['server.address'] != '',
              SpanAttributes['server.address'],
              if(SpanAttributes['http.host'] != '',
                SpanAttributes['http.host'],
                SpanAttributes['url.authority']))
          ) AS TargetName,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          count() AS CallCount,
          countIf(StatusCode = 'Error') AS ErrorCount,
          sum(Duration / 1000000) AS DurationSumMs,
          max(Duration / 1000000) AS MaxDurationMs,
          sum(SampleRate) AS SampleRateSum
        FROM traces
        WHERE SpanKind IN ('Client', 'Producer')
          AND SpanAttributes['db.system.name'] = ''
          AND ServiceName != ''
          AND (
               SpanAttributes['server.address'] != ''
            OR SpanAttributes['http.host'] != ''
            OR SpanAttributes['url.authority'] != ''
            OR SpanAttributes['messaging.destination'] != ''
            OR SpanAttributes['messaging.system'] != ''
            OR SpanAttributes['rpc.service'] != ''
            OR SpanAttributes['rpc.system'] != ''
          )
        GROUP BY OrgId, Hour, ServiceName, TargetType, TargetSystem, TargetName, DeploymentEnv
        HAVING TargetName != ''
      `,
		}),
	],
})

/**
 * Materialized view pre-aggregating per-service hosting-platform attributes per hour.
 * Picks `max()` per attribute string so non-empty values dominate empty ones —
 * "did any span in this window carry this resource attribute" semantics, which
 * is what the platform classifier needs (kubernetes / cloudflare / lambda).
 */
export const servicePlatformsHourlyMv = defineMaterializedView("service_platforms_hourly_mv", {
	description:
		"Pre-aggregates per-service hosting-platform resource attributes (k8s.*, cloud.*, faas.*) into hourly buckets for the service map's runtime-icon resolver.",
	datasource: servicePlatformsHourly,
	nodes: [
		node({
			name: "service_platforms_hourly_mv_node",
			sql: `
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
          count() AS SpanCount
        FROM traces
        WHERE ServiceName != ''
        GROUP BY OrgId, Hour, ServiceName, DeploymentEnv
      `,
		}),
	],
})

/**
 * Materialized view populating error_spans from error spans.
 * Pre-filters to StatusCode='Error' and pre-extracts deployment.environment
 * so error queries avoid scanning the full traces table and Map columns.
 */
export const errorSpansMv = defineMaterializedView("error_spans_mv", {
	description:
		"Materializes error spans from traces. Pre-filters to StatusCode='Error' and pre-extracts deployment.environment.",
	datasource: errorSpans,
	nodes: [
		node({
			name: "error_spans_mv_node",
			sql: `
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          TraceId,
          SpanId,
          ParentSpanId,
          ServiceName,
          StatusMessage,
          Duration,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv
        FROM traces
        WHERE StatusCode = 'Error'
      `,
		}),
	],
})

/**
 * Materialized view populating error_events from traces where StatusCode='Error'.
 * Unwraps the first OTel `exception` event and computes a cityHash64
 * FingerprintHash used to group occurrences into Issues.
 *
 * Fingerprint inputs: (OrgId, ServiceName, ExceptionType, top-3 normalized frames, msg fallback).
 * - Stack lines are filtered to frame-shaped ones (must contain `:NUMBER`), which
 *   skips language-specific headers like Python's "Traceback..." or Java's
 *   "Exception: message" that would otherwise leak dynamic message text into the hash.
 * - Line numbers (`:123`) and hex pointers (`0x...`) are stripped so minor code
 *   moves don't rotate the fingerprint.
 * - Top 3 frames are hashed (not just 1) so errors raised inside shared library
 *   code still distinguish between different call sites.
 * - Whenever there are no frame-shaped stack lines, a normalized prefix of
 *   StatusMessage (IDs/numbers/hex runs redacted) is folded into the hash — even
 *   when ExceptionType is present. This prevents generic types (e.g.
 *   "HttpServerError", "Error") or malformed types (e.g. a stringified JSON
 *   prefix) from monopolizing a single bucket per service.
 *
 * DeploymentEnv is intentionally NOT part of the hash: the same bug across
 * staging/prod should stay one issue; filter by env at query/triage time.
 *
 * The normalization below is mirrored in `./fingerprint.ts` (TS) for unit tests
 * across Node/Python/Java/Go stack shapes. If you change one, change both.
 */
/**
 * Shared SELECT for the error-events materializations. `error_events` (sorted by
 * FingerprintHash) and `error_events_by_time` (sorted by Timestamp) are populated
 * from the SAME projection of `traces WHERE StatusCode='Error'`; only their target
 * datasource's sort key differs. Keep the fingerprint/label logic in ONE place so the
 * two tables can never diverge — see the long note above about mirroring `fingerprint.ts`.
 */
const errorEventsSelectSql = `
        WITH
          arrayFirstIndex(n -> n = 'exception', EventsName) AS _ei,
          if(_ei > 0, EventsAttributes[_ei]['exception.type'], '') AS _exType,
          if(_ei > 0, EventsAttributes[_ei]['exception.message'], StatusMessage) AS _exMsg,
          if(_ei > 0, EventsAttributes[_ei]['exception.stacktrace'], '') AS _exStack,
          arraySlice(
            arrayFilter(
              line -> match(line, ':[0-9]+|line [0-9]+'),
              splitByChar('\\n', _exStack)
            ),
            1, 3
          ) AS _rawFrames,
          arrayMap(
            line -> replaceRegexpAll(line, ':[0-9]+|line [0-9]+|0x[0-9a-fA-F]+', ''),
            _rawFrames
          ) AS _topFrames,
          if(length(_topFrames) > 0, _topFrames[1], '') AS _topFrame,
          arrayStringConcat(_topFrames, '\\n') AS _fpFrames,
          -- JSON detection (only consulted when _fpFrames = '')
          isValidJSON(StatusMessage) AS _isJson,
          _isJson AND JSONType(StatusMessage) = 'Object' AS _isJsonObj,
          -- General, KEY-NAME-AGNOSTIC canonical signature: iterate ALL top-level
          -- keys, redact volatile tokens (long hex / numbers) in each raw value, then
          -- sort by "key=value" so key order & whitespace don't matter. No assumption
          -- about which keys exist — works for any producer's JSON shape. (Nested
          -- objects are hashed as their raw substring; only top-level is canonicalized.)
          arrayStringConcat(
            arraySort(
              arrayMap(
                kv -> concat(kv.1, '=', replaceRegexpAll(kv.2, '[0-9a-fA-F]{8,}|[0-9]+', '#')),
                JSONExtractKeysAndValuesRaw(StatusMessage)
              )
            ),
            '|'
          ) AS _jsonSig,
          -- Fold into the existing fallback hash slot. Non-JSON path is unchanged.
          multiIf(
            _fpFrames != '', '',
            _isJsonObj,      _jsonSig,
            replaceRegexpAll(substring(StatusMessage, 1, 200), '[0-9a-fA-F]{8,}|[0-9]+', '#')
          ) AS _msgFallback,
          -- Display-only, best-effort human label (decoupled from the fingerprint:
          -- many labels may map to one hash). The broad key list here is a DISPLAY
          -- heuristic only; the fingerprint above makes no key-name assumption.
          multiIf(
            JSONExtractString(StatusMessage, 'title')   != '', JSONExtractString(StatusMessage, 'title'),
            JSONExtractString(StatusMessage, 'message') != '', JSONExtractString(StatusMessage, 'message'),
            JSONExtractString(StatusMessage, 'error')   != '', JSONExtractString(StatusMessage, 'error'),
            JSONExtractString(StatusMessage, '_tag')    != '', JSONExtractString(StatusMessage, '_tag'),
            JSONExtractString(StatusMessage, 'reason')  != '', JSONExtractString(StatusMessage, 'reason'),
            JSONExtractString(StatusMessage, 'name')    != '', JSONExtractString(StatusMessage, 'name'),
            JSONExtractString(StatusMessage, 'type')    != '', extract(JSONExtractString(StatusMessage, 'type'), '([^/]+)$'),
            'JSON error'
          ) AS _jsonLabel,
          multiIf(
            StatusMessage = '', 'Unknown Error',
            position(StatusMessage, '{ readonly') = 1 OR position(StatusMessage, '└─') > 0,
              if(
                extract(StatusMessage, 'readonly (\\\\w+)') != '',
                concat('Schema parse error: ', extract(StatusMessage, 'readonly (\\\\w+)')),
                'Schema parse error'
              ),
            _isJsonObj OR position(StatusMessage, '[') = 1, _jsonLabel,
            left(StatusMessage, multiIf(
              position(StatusMessage, ': ')  > 3, toInt64(position(StatusMessage, ': '))  - 1,
              position(StatusMessage, ' (')  > 3, toInt64(position(StatusMessage, ' (')) - 1,
              position(StatusMessage, '\\n') > 3, toInt64(position(StatusMessage, '\\n')) - 1,
              least(toInt64(length(StatusMessage)), 150)
            ))
          ) AS _statusLabel,
          if(_exType != '', _exType, _statusLabel) AS _errorLabel
        SELECT
          OrgId,
          toDateTime(Timestamp) AS Timestamp,
          TraceId,
          SpanId,
          ParentSpanId,
          ServiceName,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          _exType AS ExceptionType,
          _exMsg AS ExceptionMessage,
          _exStack AS ExceptionStacktrace,
          _topFrame AS TopFrame,
          cityHash64(OrgId, ServiceName, _exType, _fpFrames, _msgFallback) AS FingerprintHash,
          StatusMessage,
          Duration,
          _errorLabel AS ErrorLabel
        FROM traces
        WHERE StatusCode = 'Error'
      `

export const errorEventsMv = defineMaterializedView("error_events_mv", {
	description:
		"Materializes per-occurrence error events from traces. Unwraps the first OTel exception event and computes a cityHash64 FingerprintHash for issue grouping.",
	datasource: errorEvents,
	nodes: [
		node({
			name: "error_events_mv_node",
			sql: errorEventsSelectSql,
		}),
	],
})

/**
 * Same per-occurrence projection as `error_events_mv`, written to the time-ordered
 * `error_events_by_time` datasource so recent-window scans (errorIssuesScan tick +
 * dashboard error queries) can prune by Timestamp. See `errorEventsByTime` in
 * datasources.ts for why both sort orders exist.
 */
export const errorEventsByTimeMv = defineMaterializedView("error_events_by_time_mv", {
	description:
		"Time-ordered copy of error_events_mv's projection, written to error_events_by_time (sorted by OrgId, Timestamp, FingerprintHash) for recent-window error scans.",
	datasource: errorEventsByTime,
	nodes: [
		node({
			name: "error_events_by_time_mv_node",
			sql: errorEventsSelectSql,
		}),
	],
})

export const traceDetailSpansMv = defineMaterializedView("trace_detail_spans_mv", {
	description: "Populates trace_detail_spans with all spans re-sorted by TraceId for fast detail lookups",
	datasource: traceDetailSpans,
	nodes: [
		node({
			name: "trace_detail_spans_mv_node",
			sql: `
        SELECT
          OrgId,
          Timestamp,
          TraceId,
          SpanId,
          ParentSpanId,
          SpanName,
          SpanKind,
          ServiceName,
          Duration,
          StatusCode,
          StatusMessage,
          SpanAttributes,
          ResourceAttributes,
          EventsTimestamp,
          EventsName,
          EventsAttributes
        FROM traces
      `,
		}),
	],
})

export const traceListMvMv = defineMaterializedView("trace_list_mv_mv", {
	description:
		"Populates trace_list_mv from root spans with pre-extracted HTTP attributes and normalized span names.",
	datasource: traceListMv,
	nodes: [
		node({
			name: "trace_list_mv_node",
			sql: `
        SELECT
          OrgId,
          TraceId,
          toDateTime(Timestamp) AS Timestamp,
          ServiceName,
          if(
            (SpanName LIKE 'http.server %' OR SpanName IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'))
            AND (SpanAttributes['http.route'] != '' OR SpanAttributes['url.path'] != ''),
            concat(
              if(SpanName LIKE 'http.server %', replaceOne(SpanName, 'http.server ', ''), SpanName),
              ' ',
              if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], SpanAttributes['url.path'])
            ),
            SpanName
          ) AS SpanName,
          SpanKind,
          Duration,
          StatusCode,
          if(SpanAttributes['http.method'] != '', SpanAttributes['http.method'], SpanAttributes['http.request.method']) AS HttpMethod,
          if(SpanAttributes['http.route'] != '', SpanAttributes['http.route'], if(SpanAttributes['url.path'] != '', SpanAttributes['url.path'], SpanAttributes['http.target'])) AS HttpRoute,
          if(SpanAttributes['http.status_code'] != '', SpanAttributes['http.status_code'], SpanAttributes['http.response.status_code']) AS HttpStatusCode,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          toUInt8(
            StatusCode = 'Error'
            OR (SpanAttributes['http.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.status_code']) >= 500)
            OR (SpanAttributes['http.response.status_code'] != '' AND toUInt16OrZero(SpanAttributes['http.response.status_code']) >= 500)
          ) AS HasError,
          TraceState,
          ResourceAttributes['service.namespace'] AS ServiceNamespace
        FROM traces
        WHERE ParentSpanId = ''
      `,
		}),
	],
})

// ---------------------------------------------------------------------------
// Attribute key aggregation MVs
// ---------------------------------------------------------------------------

export const traceSpanAttributeKeysMv = defineMaterializedView("trace_span_attribute_keys_mv", {
	description: "Aggregates span attribute keys from traces hourly.",
	datasource: attributeKeysHourly,
	nodes: [
		node({
			name: "trace_span_attribute_keys_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          arrayJoin(mapKeys(SpanAttributes)) AS AttributeKey,
          'span' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        WHERE SpanAttributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
		}),
	],
})

export const traceResourceAttributeKeysMv = defineMaterializedView("trace_resource_attribute_keys_mv", {
	description: "Aggregates resource attribute keys from traces hourly.",
	datasource: attributeKeysHourly,
	nodes: [
		node({
			name: "trace_resource_attribute_keys_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          arrayJoin(mapKeys(ResourceAttributes)) AS AttributeKey,
          'resource' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        WHERE ResourceAttributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
		}),
	],
})

export const logAttributeKeysMv = defineMaterializedView("log_attribute_keys_mv", {
	description: "Aggregates log attribute keys from logs hourly.",
	datasource: attributeKeysHourly,
	nodes: [
		node({
			name: "log_attribute_keys_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          arrayJoin(mapKeys(LogAttributes)) AS AttributeKey,
          'log' AS AttributeScope,
          count() AS UsageCount
        FROM logs
        WHERE LogAttributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
		}),
	],
})

export const metricAttributeKeysMv = defineMaterializedView("metric_attribute_keys_mv", {
	description: "Aggregates metric attribute keys from metrics_sum hourly.",
	datasource: attributeKeysHourly,
	nodes: [
		node({
			name: "metric_attribute_keys_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          arrayJoin(mapKeys(Attributes)) AS AttributeKey,
          'metric' AS AttributeScope,
          count() AS UsageCount
        FROM metrics_sum
        WHERE Attributes != map()
        GROUP BY OrgId, Hour, AttributeKey, AttributeScope
      `,
		}),
	],
})

// ---------------------------------------------------------------------------
// Metric catalog — one MV per raw metric table, all feeding `metric_catalog`.
// Each hourly-rolls up distinct metrics so the Metrics page discovery queries
// read the tiny catalog instead of scanning raw datapoints.
// ---------------------------------------------------------------------------

export const metricCatalogSumMv = defineMaterializedView("metric_catalog_sum_mv", {
	description: "Hourly rollup of distinct sum metrics into metric_catalog.",
	datasource: metricCatalog,
	nodes: [
		node({
			name: "metric_catalog_sum_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          'sum' AS MetricType,
          ServiceName,
          MetricName,
          anyLast(MetricDescription) AS MetricDescription,
          anyLast(MetricUnit) AS MetricUnit,
          anyLast(toUInt8(IsMonotonic)) AS IsMonotonic,
          count() AS DataPointCount,
          min(toDateTime(TimeUnix)) AS FirstSeen,
          max(toDateTime(TimeUnix)) AS LastSeen
        FROM metrics_sum
        GROUP BY OrgId, Hour, MetricType, ServiceName, MetricName
      `,
		}),
	],
})

/**
 * Hourly per-series argMax(value) rollup of the span-metrics calls counter into
 * span_metrics_calls_hourly. Keyed per series-epoch so per-hour increase can be
 * derived as LastValue(hour) − LastValue(prev hour) at read time. The attribute
 * Maps are folded into cityHash64 fingerprints (fixed-width series identity).
 */
export const spanMetricsCallsHourlyMv = defineMaterializedView("span_metrics_calls_hourly_mv", {
	description:
		"Hourly per-series argMax(value) rollup of the span-metrics calls counter into span_metrics_calls_hourly.",
	datasource: spanMetricsCallsHourly,
	nodes: [
		node({
			name: "span_metrics_calls_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          ServiceName,
          MetricName,
          Attributes['span.kind'] AS SpanKind,
          cityHash64(mapKeys(Attributes), mapValues(Attributes)) AS AttrFingerprint,
          cityHash64(mapKeys(ResourceAttributes), mapValues(ResourceAttributes)) AS ResourceFingerprint,
          StartTimeUnix,
          argMaxState(Value, TimeUnix) AS LastValue
        FROM metrics_sum
        WHERE MetricName IN ('span.metrics.calls', 'calls') AND IsMonotonic
        GROUP BY OrgId, Hour, ServiceName, MetricName, SpanKind, AttrFingerprint, ResourceFingerprint, StartTimeUnix
      `,
		}),
	],
})

export const metricCatalogGaugeMv = defineMaterializedView("metric_catalog_gauge_mv", {
	description: "Hourly rollup of distinct gauge metrics into metric_catalog.",
	datasource: metricCatalog,
	nodes: [
		node({
			name: "metric_catalog_gauge_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          'gauge' AS MetricType,
          ServiceName,
          MetricName,
          anyLast(MetricDescription) AS MetricDescription,
          anyLast(MetricUnit) AS MetricUnit,
          toUInt8(0) AS IsMonotonic,
          count() AS DataPointCount,
          min(toDateTime(TimeUnix)) AS FirstSeen,
          max(toDateTime(TimeUnix)) AS LastSeen
        FROM metrics_gauge
        GROUP BY OrgId, Hour, MetricType, ServiceName, MetricName
      `,
		}),
	],
})

export const metricCatalogHistogramMv = defineMaterializedView("metric_catalog_histogram_mv", {
	description: "Hourly rollup of distinct histogram metrics into metric_catalog.",
	datasource: metricCatalog,
	nodes: [
		node({
			name: "metric_catalog_histogram_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          'histogram' AS MetricType,
          ServiceName,
          MetricName,
          anyLast(MetricDescription) AS MetricDescription,
          anyLast(MetricUnit) AS MetricUnit,
          toUInt8(0) AS IsMonotonic,
          count() AS DataPointCount,
          min(toDateTime(TimeUnix)) AS FirstSeen,
          max(toDateTime(TimeUnix)) AS LastSeen
        FROM metrics_histogram
        GROUP BY OrgId, Hour, MetricType, ServiceName, MetricName
      `,
		}),
	],
})

export const metricCatalogExpHistogramMv = defineMaterializedView("metric_catalog_exp_histogram_mv", {
	description: "Hourly rollup of distinct exponential histogram metrics into metric_catalog.",
	datasource: metricCatalog,
	nodes: [
		node({
			name: "metric_catalog_exp_histogram_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          'exponential_histogram' AS MetricType,
          ServiceName,
          MetricName,
          anyLast(MetricDescription) AS MetricDescription,
          anyLast(MetricUnit) AS MetricUnit,
          toUInt8(0) AS IsMonotonic,
          count() AS DataPointCount,
          min(toDateTime(TimeUnix)) AS FirstSeen,
          max(toDateTime(TimeUnix)) AS LastSeen
        FROM metrics_exponential_histogram
        GROUP BY OrgId, Hour, MetricType, ServiceName, MetricName
      `,
		}),
	],
})

export const logAttributeValuesMv = defineMaterializedView("log_attribute_values_mv", {
	description: "Aggregates log attribute values from logs hourly.",
	datasource: attributeValuesHourly,
	nodes: [
		node({
			name: "log_attribute_values_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          AttributeKey,
          AttributeValue,
          'log' AS AttributeScope,
          count() AS UsageCount
        FROM logs
        ARRAY JOIN
          mapKeys(LogAttributes) AS AttributeKey,
          mapValues(LogAttributes) AS AttributeValue
        WHERE AttributeValue != ''
        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope
      `,
		}),
	],
})

export const metricAttributeValuesMv = defineMaterializedView("metric_attribute_values_mv", {
	description: "Aggregates metric attribute values from metrics_sum hourly.",
	datasource: attributeValuesHourly,
	nodes: [
		node({
			name: "metric_attribute_values_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(TimeUnix)) AS Hour,
          AttributeKey,
          AttributeValue,
          'metric' AS AttributeScope,
          count() AS UsageCount
        FROM metrics_sum
        ARRAY JOIN
          mapKeys(Attributes) AS AttributeKey,
          mapValues(Attributes) AS AttributeValue
        WHERE AttributeValue != ''
        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope
      `,
		}),
	],
})

export const traceSpanAttributeValuesMv = defineMaterializedView("trace_span_attribute_values_mv", {
	description: "Aggregates span attribute values from traces hourly.",
	datasource: attributeValuesHourly,
	nodes: [
		node({
			name: "trace_span_attribute_values_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          AttributeKey,
          AttributeValue,
          'span' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        ARRAY JOIN
          mapKeys(SpanAttributes) AS AttributeKey,
          mapValues(SpanAttributes) AS AttributeValue
        WHERE AttributeValue != ''
        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope
      `,
		}),
	],
})

export const traceResourceAttributeValuesMv = defineMaterializedView("trace_resource_attribute_values_mv", {
	description: "Aggregates resource attribute values from traces hourly.",
	datasource: attributeValuesHourly,
	nodes: [
		node({
			name: "trace_resource_attribute_values_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          AttributeKey,
          AttributeValue,
          'resource' AS AttributeScope,
          count() AS UsageCount
        FROM traces
        ARRAY JOIN
          mapKeys(ResourceAttributes) AS AttributeKey,
          mapValues(ResourceAttributes) AS AttributeValue
        WHERE AttributeValue != ''
        GROUP BY OrgId, Hour, AttributeKey, AttributeValue, AttributeScope
      `,
		}),
	],
})

/**
 * Populates traces_aggregates_hourly with sample-weighted -State aggregates.
 * One row per (OrgId, Hour, ServiceName, SpanName, SpanKind, StatusCode,
 * IsEntryPoint, DeploymentEnv) tuple. The query layer routes timeseries +
 * breakdown queries here when filters/groupBy align.
 *
 * Cardinality note: SpanName is in the sort key. If any tenant emits high-
 * cardinality span names (per-request data instead of templated routes),
 * the row count grows quickly. See docs/persistence.md and the cardinality
 * pre-flight query in the rollout plan.
 */
export const tracesAggregatesHourlyMv = defineMaterializedView("traces_aggregates_hourly_mv", {
	description:
		"Pre-aggregates spans hourly with sample-weighted state columns (count, duration sum, t-digest quantiles, error count). Sample-correct from day one via SampleRate materialized column on traces.",
	datasource: tracesAggregatesHourly,
	nodes: [
		node({
			name: "traces_aggregates_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(toDateTime(Timestamp)) AS Hour,
          ServiceName,
          SpanName,
          SpanKind,
          StatusCode,
          IsEntryPoint,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          sum(SampleRate) AS WeightedCount,
          sum(toFloat64(Duration) * SampleRate) AS WeightedDurationSum,
          sumIf(SampleRate, StatusCode = 'Error') AS WeightedErrorCount,
          quantilesTDigestWeightedState(0.5, 0.95, 0.99)(Duration, toUInt32(SampleRate)) AS DurationQuantiles,
          min(Duration) AS DurationMin,
          max(Duration) AS DurationMax
        FROM traces
        GROUP BY OrgId, Hour, ServiceName, SpanName, SpanKind, StatusCode, IsEntryPoint, DeploymentEnv
      `,
		}),
	],
})

/**
 * Populates logs_aggregates_hourly. Severity-aware drop-in for
 * severity-distribution and log-volume dashboards.
 */
export const logsAggregatesHourlyMv = defineMaterializedView("logs_aggregates_hourly_mv", {
	description:
		"Pre-aggregates logs hourly by service × severity × deployment env. Drop-in for severity-distribution and log-volume queries.",
	datasource: logsAggregatesHourly,
	nodes: [
		node({
			name: "logs_aggregates_hourly_mv_node",
			sql: `
        SELECT
          OrgId,
          toStartOfHour(TimestampTime) AS Hour,
          ServiceName,
          SeverityText,
          ResourceAttributes['deployment.environment'] AS DeploymentEnv,
          count() AS Count,
          sum(length(Body) + 200) AS SizeBytes,
          ResourceAttributes['service.namespace'] AS ServiceNamespace
        FROM logs
        GROUP BY OrgId, Hour, ServiceName, SeverityText, DeploymentEnv, ServiceNamespace
      `,
		}),
	],
})
