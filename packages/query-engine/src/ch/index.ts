// ---------------------------------------------------------------------------
// ClickHouse Query DSL — Maple facade
//
// The generic, reusable query builder now lives in the standalone
// @maple-dev/clickhouse-builder package. This module re-exports that public API
// and layers Maple's OpenTelemetry-specific table definitions, the named-query
// ("pipe") registry, and the pre-built query templates on top of it.
// ---------------------------------------------------------------------------

// Generic DSL — types, table, expressions, functions, params, query builder,
// compilation, and unions — re-exported from the standalone library.
export * from "@maple-dev/clickhouse-builder"

// Pipe dispatch — maps Tinybird-style pipe names + params to compiled CH SQL.
// Shared by the cloud WarehouseQueryService and the local CLI executor so both
// resolve a pipe name to identical SQL.
export { compilePipeQuery, type PipeCompiledQuery } from "./pipe-dispatch"

// Tables
export * as tables from "./tables"

// Shared row-schema codecs (ClickHouse `FORMAT JSON` 64-bit-int-as-string coercion).
export { CHNumber } from "./schema"

// Queries — Traces
export {
	tracesTimeseriesQuery,
	tracesBreakdownQuery,
	tracesListQuery,
	tracesRootListQuery,
	traceSummariesQuery,
	slowTracesQuery,
	spanSearchQuery,
	type TracesTimeseriesOpts,
	type TracesBreakdownOpts,
	type TracesListOpts,
	type TracesRootListOpts,
	type TracesTimeseriesOutput,
	type TracesBreakdownOutput,
	type TracesListOutput,
	type TracesRootListOutput,
	type TraceSummariesOpts,
	type TraceSummaryOutput,
	type SlowTracesOpts,
	type SlowTracesOutput,
	type SpanSearchOpts,
	type SpanSearchOutput,
} from "./queries/traces"

// Queries — Attribute Keys & Values
export {
	attributeKeysQuery,
	spanAttributeValuesQuery,
	resourceAttributeValuesQuery,
	logAttributeValuesQuery,
	metricAttributeValuesQuery,
	metricScopedAttributeKeysQuery,
	metricScopedAttributeValuesQuery,
	type MetricScopedAttributeKeysOpts,
	type MetricScopedAttributeValuesOpts,
	type AttributeKeysQueryOpts,
	type AttributeKeysOutput,
	type AttributeValuesOpts,
	type AttributeValuesOutput,
} from "./queries/attribute-keys"

// Queries — Metrics
export {
	metricsTimeseriesQuery,
	metricsTimeseriesRateQuery,
	metricsBreakdownQuery,
	metricsSparklinesQuery,
	type MetricsSparklinesOpts,
	type MetricsSparklinesOutput,
	type MetricsTimeseriesOpts,
	type MetricsTimeseriesOutput,
	type MetricsRateTimeseriesOpts,
	type MetricsRateTimeseriesOutput,
	type MetricsBreakdownOpts,
	type MetricsBreakdownOutput,
	listMetricsQuery,
	metricsSummaryQuery,
	type ListMetricsOpts,
	type ListMetricsOutput,
	type MetricsSummaryOpts,
	type MetricsSummaryOutput,
} from "./queries/metrics"

// Queries — Logs
export {
	logsTimeseriesQuery,
	canUseLogsAggregatesHourly,
	logsBreakdownQuery,
	logsCountQuery,
	logsListQuery,
	getLogByKeyQuery,
	logsFacetsQuery,
	errorRateByServiceQuery,
	type LogsTimeseriesOpts,
	type LogsTimeseriesOutput,
	type LogsBreakdownOpts,
	type LogsBreakdownOutput,
	type LogsCountOutput,
	type LogsListOpts,
	type LogsListOutput,
	type LogByKeyOpts,
	type LogsFacetsOutput,
	type ErrorRateByServiceOutput,
} from "./queries/logs"

// Queries — Session Replays
export {
	sessionReplaysListQuery,
	sessionReplaysFacetsQuery,
	getSessionReplayQuery,
	sessionReplayEventsQuery,
	sessionsForTraceQuery,
	sessionTraceSummariesQuery,
	type SessionReplaysListOpts,
	type SessionReplaysListOutput,
	type SessionReplaysFacetsOpts,
	type SessionReplaysFacetsOutput,
	type SessionReplayDetailOutput,
	type SessionReplayEventsOutput,
	type SessionsForTraceOpts,
	type SessionsForTraceOutput,
	type SessionTraceSummariesOpts,
	type SessionTraceSummaryOutput,
} from "./queries/session-replays"

// Queries — Session Events (distilled stream)
export {
	sessionTranscriptQuery,
	sessionEventMatchQuery,
	sessionActivityQuery,
	sessionActivityAggregateQuery,
	IDLE_GAP_THRESHOLD_MS,
	type SessionTranscriptOutput,
	type SessionEventMatchOpts,
	type SessionActivityOpts,
	type SessionActivityOutput,
} from "./queries/session-events"

// Queries — Services
export {
	serviceOverviewQuery,
	serviceCatalogQuery,
	serviceHealthBaselineQuery,
	serviceReleasesTimelineQuery,
	serviceEnvironmentsQuery,
	serviceApdexTimeseriesQuery,
	serviceUsageQuery,
	serviceUsageWithPreviousQuery,
	servicesFacetsQuery,
	type ServiceOverviewOpts,
	type ServiceOverviewOutput,
	type ServiceCatalogOpts,
	type ServiceCatalogOutput,
	type ServiceHealthBaselineOpts,
	type ServiceHealthBaselineOutput,
	type ServiceReleasesTimelineOpts,
	type ServiceReleasesTimelineOutput,
	type ServiceEnvironmentsOpts,
	type ServiceEnvironmentsOutput,
	type ServiceApdexTimeseriesOpts,
	type ServiceApdexTimeseriesOutput,
	type ServiceUsageOpts,
	type ServiceUsageOutput,
	type ServiceUsageWithPreviousOutput,
	type ServicesFacetsOutput,
} from "./queries/services"

// Queries — Errors
export {
	errorsByTypeQuery,
	errorsTimeseriesQuery,
	spanHierarchyQuery,
	SPAN_HIERARCHY_MAX_SPANS,
	spanDetailQuery,
	traceTimeProbeQuery,
	tracesDurationStatsQuery,
	tracesFacetsQuery,
	errorsFacetsQuery,
	errorsSummaryQuery,
	errorDetailTracesQuery,
	errorIssuesQuery,
	errorIssueTimeseriesQuery,
	errorIssueSampleTracesQuery,
	type ErrorsByTypeOpts,
	type ErrorsByTypeOutput,
	type ErrorsTimeseriesOpts,
	type ErrorsTimeseriesOutput,
	type SpanHierarchyOpts,
	type SpanHierarchyOutput,
	type SpanDetailOpts,
	type SpanDetailOutput,
	type TraceTimeProbeOutput,
	type TracesDurationStatsOpts,
	type TracesDurationStatsOutput,
	type TracesFacetsOpts,
	type TracesFacetsOutput,
	type ErrorsFacetsOpts,
	type ErrorsFacetsOutput,
	type ErrorsSummaryOpts,
	type ErrorsSummaryOutput,
	type ErrorDetailTracesOpts,
	type ErrorDetailTracesOutput,
	type ErrorIssuesOpts,
	type ErrorIssuesOutput,
	type ErrorIssueTimeseriesOutput,
	type ErrorIssueSampleTracesOutput,
} from "./queries/errors"

// Queries — Anomaly detector
export {
	anomalyTraceSignalsQuery,
	anomalyLogVolumeQuery,
	anomalyErrorSpikeCurrentQuery,
	anomalyErrorSpikeBaselineQuery,
	anomalyTraceSignalTimeseriesQuery,
	anomalyLogVolumeTimeseriesQuery,
	anomalyErrorSpikeTimeseriesQuery,
	anomalyErrorSpikeServiceTimeseriesQuery,
	matchedHoursOfDay,
	type AnomalyTraceSignalsOpts,
	type AnomalyTraceSignalsOutput,
	type AnomalyLogVolumeOutput,
	type AnomalyErrorSpikeCurrentOutput,
	type AnomalyErrorSpikeBaselineOutput,
	type AnomalyTraceSignalTimeseriesOutput,
	type AnomalyLogVolumeTimeseriesOutput,
	type AnomalyErrorSpikeTimeseriesOutput,
} from "./queries/anomaly"

// Queries — Active-org discovery (cross-org; gate per-org cron fan-out)
export {
	activeOrgsByErrorEventsQuery,
	activeOrgsByTracesQuery,
	activeOrgsByLogsQuery,
	type ActiveOrgsOutput,
} from "./queries/activity"

// Queries — Service Map
export {
	serviceDependenciesSQL,
	serviceDependenciesForServiceQuery,
	serviceDbEdgesSQL,
	serviceDbEdgesForServiceQuery,
	serviceDbQuerySummarySQL,
	serviceDbQueryTimeseriesSQL,
	serviceDbTopQueriesSQL,
	servicePlatformsSQL,
	serviceMapEdgeJoinSQL,
	type ServiceDependenciesOpts,
	type ServiceDependenciesForServiceOpts,
	type ServiceDependenciesOutput,
	type ServiceDbEdgesOpts,
	type ServiceDbEdgesForServiceOpts,
	type ServiceDbEdgesOutput,
	type ServiceDbQuerySummaryParams,
	type ServiceDbQuerySummaryOutput,
	type ServiceDbQueryTimeseriesOutput,
	type ServiceDbTopQueryOutput,
	type ServicePlatformsOpts,
	type ServicePlatformsOutput,
	serviceExternalEdgesSQL,
	type ServiceExternalEdgesOpts,
	type ServiceExternalEdgesOutput,
} from "./queries/service-map"

// Queries — Service Map hourly edge rollup
export {
	serviceMapEdgesRollupSQL,
	serviceMapEdgesExistingHoursSQL,
	serviceMapResolutionsRollupSQL,
	type ServiceMapEdgesRollupParams,
	type ServiceMapEdgesHourlyOutput,
	type ServiceMapEdgesExistingHour,
	type ServiceAddressResolutionsHourlyOutput,
} from "./queries/service-map-rollup"

// Queries — Service Infrastructure (service.name ↔ k8s workload join)
export {
	serviceWorkloadsSQL,
	type ServiceWorkloadsOpts,
	type ServiceWorkloadsOutput,
} from "./queries/service-infra"

// Queries — Alerts: removed. Alert evaluation now reuses the dashboard
// timeseries queries (tracesTimeseriesQuery / logsTimeseriesQuery /
// metricsTimeseriesQuery) so dashboards and alerts share the same grouping
// and filter semantics. See `makeQueryEngineEvaluate` in @maple/query-engine/runtime.

// Queries — Service Operations (per-SpanName breakdown for the service detail page)
export {
	serviceOperationsSummaryQuery,
	serviceOperationsSummaryRawQuery,
	serviceOperationsSummaryRowSchema,
	serviceOperationsTimeseriesQuery,
	serviceOperationsTimeseriesRawQuery,
	serviceOperationsTimeseriesRowSchema,
	type ServiceOperationsSummaryOpts,
	type ServiceOperationsSummaryOutput,
	type ServiceOperationsTimeseriesOpts,
	type ServiceOperationsTimeseriesOutput,
} from "./queries/service-operations"

// Queries — Alert Checks (historical rule evaluations)
export {
	listRuleChecksQuery,
	type ListRuleChecksOpts,
	type ListRuleChecksOutput,
} from "./queries/alert-checks"

// Queries — Cloudflare integration usage (integrations-page ingest proof)
export {
	CLOUDFLARE_USAGE_METRIC_NAMES,
	cloudflareUsageQuery,
	cloudflareUsageRowSchema,
	type CloudflareUsageOutput,
} from "./queries/cloudflare-usage"

// Queries — Cloudflare service-map stats (per-zone / per-Worker node rollups)
export {
	cloudflareServiceCountersRowSchema,
	cloudflareServiceCountersSQL,
	cloudflareServiceLatencyRowSchema,
	cloudflareServiceLatencySQL,
	type CloudflareServiceCountersOutput,
	type CloudflareServiceLatencyOutput,
} from "./queries/cloudflare-map"

// Queries — PlanetScale service-map stats (per-database / per-branch rollups)
export {
	planetscaleBranchConnectionsRowSchema,
	planetscaleBranchConnectionsSQL,
	planetscaleBranchGaugesSQL,
	planetscaleBranchStatsRowSchema,
	planetscaleConnectionsRowSchema,
	planetscaleConnectionsSQL,
	planetscaleDatabaseStatsRowSchema,
	planetscaleGaugesSQL,
	type PlanetScaleBranchConnectionsOutput,
	type PlanetScaleBranchStatsOutput,
	type PlanetScaleConnectionsOutput,
	type PlanetScaleDatabaseStatsOutput,
} from "./queries/planetscale-map"

// Queries — PlanetScale infrastructure page (per-database timeseries)
export {
	planetscaleInfraTimeseriesRowSchema,
	planetscaleInfraTimeseriesSQL,
	type PlanetScaleInfraTimeseriesOutput,
} from "./queries/planetscale-infra"

// Queries — Cloudflare infrastructure page (per-zone HTTP + per-Worker rollups & timeseries)
export {
	cloudflareZoneCountersRowSchema,
	cloudflareZoneCountersSQL,
	cloudflareZoneLatencyRowSchema,
	cloudflareZoneLatencySQL,
	cloudflareZoneTimeseriesRowSchema,
	cloudflareZoneTimeseriesSQL,
	cloudflareZoneStatusTimeseriesRowSchema,
	cloudflareZoneStatusTimeseriesSQL,
	cloudflareZoneCacheTimeseriesRowSchema,
	cloudflareZoneCacheTimeseriesSQL,
	cloudflareZoneLatencyTimeseriesRowSchema,
	cloudflareZoneLatencyTimeseriesSQL,
	cloudflareWorkerCountersRowSchema,
	cloudflareWorkerCountersSQL,
	cloudflareWorkerLatencyRowSchema,
	cloudflareWorkerLatencySQL,
	cloudflareWorkerTimeseriesRowSchema,
	cloudflareWorkerTimeseriesSQL,
	type CloudflareZoneCountersOutput,
	type CloudflareZoneLatencyOutput,
	type CloudflareZoneTimeseriesOutput,
	type CloudflareZoneStatusTimeseriesOutput,
	type CloudflareZoneCacheTimeseriesOutput,
	type CloudflareZoneLatencyTimeseriesOutput,
	type CloudflareWorkerCountersOutput,
	type CloudflareWorkerLatencyOutput,
	type CloudflareWorkerTimeseriesOutput,
} from "./queries/cloudflare-infra"

// Queries — Cloudflare infrastructure page, extended datasets (hosts, firewall, DNS, platform)
export {
	cloudflareZoneHostBreakdownRowSchema,
	cloudflareZoneHostBreakdownSQL,
	cloudflareZoneHostTimeseriesRowSchema,
	cloudflareZoneHostTimeseriesSQL,
	cloudflareZoneFirewallTimeseriesRowSchema,
	cloudflareZoneFirewallTimeseriesSQL,
	cloudflareZoneFirewallTopRowSchema,
	cloudflareZoneFirewallTopSQL,
	cloudflareZoneDnsTimeseriesRowSchema,
	cloudflareZoneDnsTimeseriesSQL,
	cloudflareZoneDnsBreakdownRowSchema,
	cloudflareZoneDnsBreakdownSQL,
	cloudflareQueueGaugesRowSchema,
	cloudflareQueueGaugesSQL,
	cloudflareDurableObjectCountersRowSchema,
	cloudflareDurableObjectCountersSQL,
	type CloudflareZoneHostBreakdownOutput,
	type CloudflareZoneHostTimeseriesOutput,
	type CloudflareZoneFirewallTimeseriesOutput,
	type CloudflareZoneFirewallTopOutput,
	type CloudflareZoneDnsTimeseriesOutput,
	type CloudflareZoneDnsBreakdownOutput,
	type CloudflareQueueGaugesOutput,
	type CloudflareDurableObjectCountersOutput,
} from "./queries/cloudflare-infra-extended"

// Queries — Internal observability (Maple's own self-instrumentation)
export {
	dbStatementSamplesQuery,
	type DbStatementSamplesOpts,
	type DbStatementSamplesOutput,
} from "./queries/internal"

// Queries — Local ingest pulse (drives the local-mode header heartbeat)
export { localIngestPulseQuery, type LocalIngestPulseOutput } from "./queries/ingest"

// Queries — Top Operations (per-service operation ranking by metric)
export {
	topOperationsQuery,
	type TopOperationsMetric,
	type TopOperationsOpts,
	type TopOperationsOutput,
} from "./queries/top-operations"

// Queries — Infrastructure (host-centric aggregations over hostmetrics)
export {
	listHostsQuery,
	hostDetailSummaryQuery,
	hostGaugeTimeseriesQuery,
	hostNetworkTimeseriesQuery,
	fleetUtilizationTimeseriesQuery,
	listPodsQuery,
	podDetailSummaryQuery,
	podGaugeTimeseriesQuery,
	podFacetsQuery,
	listNodesQuery,
	nodeDetailSummaryQuery,
	nodeGaugeTimeseriesQuery,
	nodeFacetsQuery,
	listWorkloadsQuery,
	workloadDetailSummaryQuery,
	workloadGaugeTimeseriesQuery,
	workloadFacetsQuery,
	type ListHostsOpts,
	type ListHostsOutput,
	type HostDetailSummaryOpts,
	type HostDetailSummaryOutput,
	type HostGaugeTimeseriesOpts,
	type HostGaugeTimeseriesOutput,
	type HostNetworkTimeseriesOpts,
	type HostNetworkTimeseriesOutput,
	type FleetUtilizationTimeseriesOutput,
	type ListPodsOpts,
	type ListPodsOutput,
	type PodDetailSummaryOpts,
	type PodDetailSummaryOutput,
	type PodGaugeTimeseriesOpts,
	type PodFacetsOutput,
	type ListNodesOpts,
	type ListNodesOutput,
	type NodeDetailSummaryOpts,
	type NodeDetailSummaryOutput,
	type NodeGaugeTimeseriesOpts,
	type NodeFacetsOutput,
	type ListWorkloadsOpts,
	type ListWorkloadsOutput,
	type WorkloadDetailSummaryOpts,
	type WorkloadDetailSummaryOutput,
	type WorkloadGaugeTimeseriesOpts,
	type WorkloadFacetsOutput,
	type WorkloadKind,
} from "./queries/infra"
