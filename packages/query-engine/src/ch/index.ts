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
	canUseAnnualServiceOverview,
	tracesBreakdownQuery,
	tracesListQuery,
	tracesRootListQuery,
	traceListQuery,
	traceSummariesQuery,
	slowTracesQuery,
	spanSearchQuery,
	type TracesTimeseriesOpts,
	type TracesBreakdownOpts,
	type TracesListOpts,
	type TracesRootListOpts,
	type TraceListOpts,
	type TracesTimeseriesOutput,
	type TracesBreakdownOutput,
	type TracesListOutput,
	type TracesRootListOutput,
	type TraceListOutput,
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

// Queries — Setup audit
export {
	auditAttributeKeyInventoryQuery,
	auditAttributeKeyInventoryRowSchema,
	auditSpanShapeByServiceQuery,
	auditSpanShapeRowSchema,
	auditSamplingByServiceQuery,
	auditSamplingRowSchema,
	auditLogSeverityByServiceQuery,
	auditLogSeverityRowSchema,
	auditMetricLabelCardinalityQuery,
	auditMetricLabelRowSchema,
	auditPeerValueInventoryQuery,
	auditPeerValueRowSchema,
	auditDbEdgeIdentityQuery,
	auditDbEdgeRowSchema,
	auditLogCorrelationQuery,
	auditLogCorrelationRowSchema,
	auditOrphanSpansSQL,
	auditOrphanSpanRowSchema,
	auditRootlessTracesSQL,
	auditRootlessTraceRowSchema,
	auditTraceSampleModulus,
	AUDIT_LOG_CORRELATION_MAX_HOURS,
	AUDIT_PEER_KEYS,
	type AuditAttributeKeyRow,
	type AuditSpanShapeRow,
	type AuditSamplingRow,
	type AuditLogSeverityRow,
	type AuditMetricLabelRow,
	type AuditPeerValueRow,
	type AuditDbEdgeRow,
	type AuditLogCorrelationRow,
	type AuditOrphanSpanRow,
	type AuditRootlessTraceRow,
	type AuditTraceWindowParams,
} from "./queries/setup-audit"

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
	serviceOverviewRowSchema,
	serviceUsageRowSchema,
	serviceCatalogQuery,
	serviceHealthSnapshotQuery,
	serviceHealthSnapshotRowSchema,
	serviceHealthBaselineQuery,
	serviceReleasesTimelineQuery,
	serviceReleasesTimelineRowSchema,
	serviceEnvironmentsQuery,
	serviceApdexTimeseriesQuery,
	serviceApdexTimeseriesRowSchema,
	serviceUsageQuery,
	serviceUsageWithPreviousQuery,
	servicesFacetsQuery,
	type ServiceOverviewOpts,
	type ServiceOverviewOutput,
	type ServiceCatalogOpts,
	type ServiceCatalogOutput,
	type ServiceHealthSnapshotOpts,
	type ServiceHealthSnapshotOutput,
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
	errorFingerprintsQuery,
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
	type ErrorFingerprintsOpts,
	type ErrorFingerprintsOutput,
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
	alertCheckGroupTotalsQuery,
	alertChecksSummaryQuery,
	type ListRuleChecksOpts,
	type ListRuleChecksOutput,
	type AlertCheckGroupTotalsOpts,
	type AlertCheckGroupTotalsOutput,
	type AlertChecksSummaryOpts,
	type AlertChecksSummaryOutput,
} from "./queries/alert-checks"

// Queries — Cloudflare integration usage (integrations-page ingest proof)
export {
	BLOCKED_FIREWALL_ACTIONS,
	CLOUDFLARE_USAGE_METRIC_NAMES,
	cloudflareUsageQuery,
	cloudflareUsageRowSchema,
	cloudflareUsageStatsQuery,
	cloudflareUsageStatsRowSchema,
	type CloudflareUsageOutput,
	type CloudflareUsageStatsOutput,
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
	planetscaleBranchStorageRowSchema,
	planetscaleBranchStorageSQL,
	planetscaleConnectionsRowSchema,
	planetscaleConnectionsSQL,
	planetscaleDatabaseStatsRowSchema,
	planetscaleGaugesSQL,
	planetscaleStorageRowSchema,
	planetscaleStorageSQL,
	type PlanetScaleBranchConnectionsOutput,
	type PlanetScaleBranchStatsOutput,
	type PlanetScaleBranchStorageOutput,
	type PlanetScaleConnectionsOutput,
	type PlanetScaleDatabaseStatsOutput,
	type PlanetScaleStorageOutput,
} from "./queries/planetscale-map"

// Queries — PlanetScale infrastructure page (per-database / per-branch timeseries)
export {
	planetscaleBranchInfraTimeseriesSQL,
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

// Queries — Cloudflare zone filters (which dimensions each metric family actually carries)
export {
	CF_ATTR,
	CF_FILTERABLE,
	CF_METRIC,
	cloudflareFilterConditions,
	cloudflareHostAttr,
	cloudflareIgnoredFilters,
	cloudflareIgnoredFiltersFor,
	type CfFilterKey,
	type CloudflareFilterOpts,
} from "./queries/cloudflare-infra-filters"

// Queries — Cloudflare zone breakdowns (generic per-dimension totals/timeseries) + filter facets
export {
	CLOUDFLARE_BREAKDOWN_DIMENSIONS,
	CLOUDFLARE_BREAKDOWN_OTHER_KEY,
	CLOUDFLARE_BREAKDOWN_SERIES_LIMIT,
	cloudflareBreakdownMetrics,
	cloudflareZoneBreakdownCoverageRowSchema,
	cloudflareZoneBreakdownCoverageSQL,
	cloudflareZoneBreakdownTimeseriesRowSchema,
	cloudflareZoneBreakdownTimeseriesSQL,
	cloudflareZoneBreakdownTotalsRowSchema,
	cloudflareZoneBreakdownTotalsSQL,
	cloudflareZoneFacetsQuery,
	type CloudflareBreakdownDimension,
	type CloudflareZoneBreakdownCoverageOutput,
	type CloudflareZoneBreakdownTimeseriesOutput,
	type CloudflareZoneBreakdownTotalsOutput,
	type CloudflareZoneFacetsOutput,
} from "./queries/cloudflare-infra-breakdowns"

// Queries — Internal observability (Maple's own self-instrumentation)
export {
	dbStatementSamplesQuery,
	type DbStatementSamplesOpts,
	type DbStatementSamplesOutput,
} from "./queries/internal"

// Queries — Billing (daily ingested volume behind the spend chart)
export {
	dailySessionCountQuery,
	dailySessionCountRowSchema,
	dailySignalVolumeQuery,
	dailySignalVolumeRowSchema,
	type DailySessionCountOutput,
	type DailySignalVolumeOutput,
} from "./queries/billing-usage"

// Queries — Telemetry liveness (auto-resolve gating + local-mode header heartbeat)
export {
	orgTelemetryPulseQuery,
	serviceLivenessQuery,
	serviceLivenessRowSchema,
	telemetryPulseRowSchema,
	type ServiceLivenessOpts,
	type ServiceLivenessOutput,
	type TelemetryPulseOutput,
} from "./queries/liveness"

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
	listPodsSummaryQuery,
	ListPodsSummaryOutputSchema,
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
	type ListPodsSummaryOutput,
	type PodSortKey,
	type SortDirection,
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
