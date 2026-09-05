// ClickHouse Query DSL — Maple facade
//
// The generic, reusable query builder now lives in the standalone
// @maple-dev/clickhouse-builder package. This module re-exports that public API
// and layers Maple's OpenTelemetry-specific table definitions, the named-query
// ("pipe") registry, and the pre-built query templates on top of it.

// Generic DSL — types, table, expressions, functions, params, query builder,
// compilation, and unions — re-exported from the standalone library.
export * from "@maple-dev/clickhouse-builder"

// Handwritten SQL. Shadows the builder's `rawCompiledQuery`, whose `reason`
// is any string, with one that pins Maple's closed `RawSqlReason` union — the
// explicit export wins over the star re-export above.
export { type RawSqlReason, rawCompiledQuery } from "./raw-sql"

// Pipe dispatch — maps Tinybird-style pipe names + params to compiled CH SQL.
// Shared by the cloud WarehouseQueryService and the local CLI executor so both
// resolve a pipe name to identical SQL.
export { compilePipeQuery, type PipeCompiledQuery } from "./pipe-dispatch"

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
	traceServicesByTraceIdsQuery,
	traceSummariesQuery,
	slowTracesQuery,
	spanSearchQuery,
	type TracesTimeseriesOpts,
	type TracesBreakdownOpts,
	type TracesListOpts,
	type TracesRootListOpts,
	type TraceListOpts,
	type TraceServicesByTraceIdsOpts,
	type TracesTimeseriesOutput,
	type TracesBreakdownOutput,
	type TracesListOutput,
	type TracesRootListOutput,
	type TraceListOutput,
	type TraceServicesByTraceIdsOutput,
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
	sessionReplayChunkIndexQuery,
	sessionReplayEventsQuery,
	sessionsForTraceQuery,
	sessionTraceSummariesQuery,
	type SessionReplaysListOpts,
	type SessionReplaysListOutput,
	type SessionReplaysFacetsOpts,
	type SessionReplaysFacetsOutput,
	type SessionReplayDetailOutput,
	type SessionReplayChunkIndexOpts,
	type SessionReplayChunkIndexOutput,
	type SessionReplayEventsOpts,
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

// Queries — Web Analytics (product analytics over the browser SDK's session data)
export {
	webAnalyticsSummaryQuery,
	webAnalyticsLiveQuery,
	webAnalyticsTimeseriesQuery,
	webAnalyticsPageviewsTimeseriesQuery,
	webAnalyticsPagesQuery,
	webAnalyticsEventsQuery,
	webAnalyticsBreakdownsQuery,
	type WebAnalyticsFilters,
	type WebAnalyticsFacetKey,
	type WebAnalyticsSummaryOutput,
	type WebAnalyticsLiveOpts,
	type WebAnalyticsLiveOutput,
	type WebAnalyticsTimeseriesOpts,
	type WebAnalyticsTimeseriesOutput,
	type WebAnalyticsPageviewsTimeseriesOpts,
	type WebAnalyticsPageviewsTimeseriesOutput,
	type WebAnalyticsPagesOpts,
	type WebAnalyticsPagesOutput,
	type WebAnalyticsBreakdownsOpts,
	type WebAnalyticsBreakdownsOutput,
	type ProductEventsFilters,
} from "./queries/web-analytics"

// Queries — Product events (funnels over `product_events`)
export {
	productEventsFunnelQuery,
	productEventsFunnelRowSchema,
	productEventsFunnelBreakdownQuery,
	productEventsFunnelBreakdownRowSchema,
	productEventNamesQuery,
	productEventNamesRowSchema,
	ProductEventsFunnelError,
	FUNNEL_MAX_STEPS,
	FUNNEL_BREAKDOWN_MAX_GROUPS,
	type FunnelStep,
	type FunnelKeyBy,
	type FunnelSessionDimension,
	type FunnelBreakdownBy,
	type ProductEventsFunnelOpts,
	type ProductEventsFunnelOutput,
	type ProductEventsFunnelBreakdownOpts,
	type ProductEventsFunnelBreakdownOutput,
	type ProductEventNamesOpts,
	type ProductEventNamesOutput,
} from "./queries/product-events"

// Queries — Services
export {
	serviceOverviewQuery,
	serviceOverviewRowSchema,
	serviceUsageRowSchema,
	serviceCatalogQuery,
	serviceHealthSnapshotQuery,
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
	errorsSparkQuery,
	ErrorsSparkOutputSchema,
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
	errorTickBootstrapIssuesQuery,
	errorTickIssuesQuery,
	errorFingerprintsQuery,
	errorIssueTimeseriesQuery,
	errorIssueSampleTracesQuery,
	errorIssueEnvironmentsQuery,
	errorIssueVersionsSinceQuery,
	ErrorIssueVersionsSinceOutputSchema,
	type ErrorIssueVersionsSinceOutput,
	type ErrorsByTypeOpts,
	type ErrorsByTypeOutput,
	type ErrorsTimeseriesOpts,
	type ErrorsTimeseriesOutput,
	type ErrorsSparkOpts,
	type ErrorsSparkOutput,
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
	serviceMapEdgeJoinQuery,
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
	serviceMapResolutionsExistingHoursSQL,
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

// Queries — Service API Endpoints (the HTTP slice of the operations rollup)
export {
	serviceEndpointsSummaryQuery,
	serviceEndpointsSummaryRawQuery,
	serviceEndpointsSummaryRowSchema,
	splitEndpointName,
	type EndpointName,
	type ServiceEndpointsSummaryOpts,
	type ServiceEndpointsSummaryOutput,
} from "./queries/service-endpoints"

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

// Queries — Audit log (org-wide audit trail, admin-only)
export {
	auditLogEntriesQuery,
	type AuditLogEntriesOpts,
	type AuditLogEntriesOutput,
} from "./queries/audit-log"

// Queries — Cloudflare integration usage (integrations-page ingest proof)

// Queries — Cloudflare service-map stats (per-zone / per-Worker node rollups)

// Queries — PlanetScale service-map stats (per-database / per-branch rollups)

// Queries — PlanetScale infrastructure page (per-database / per-branch timeseries)

// Queries — Cloudflare infrastructure page (per-zone HTTP + per-Worker rollups & timeseries)

// Queries — Cloudflare infrastructure page, extended datasets (hosts, firewall, DNS, platform)

// Queries — Cloudflare zone filters (which dimensions each metric family actually carries)

// Queries — Cloudflare zone breakdowns (generic per-dimension totals/timeseries) + filter facets

// Queries — Internal observability (Maple's own self-instrumentation)

// Queries — Billing (daily ingested volume behind the spend chart)

// Queries — Telemetry liveness (auto-resolve gating + local-mode header heartbeat)
export {
	orgTelemetryPulseQuery,
	serviceLivenessQuery,
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
	infraPresenceQuery,
	type InfraSurface,
	type InfraPresenceOutput,
} from "./queries/infra"

// Queries — Containers (Docker, docker_stats receiver)
export {
	listContainersQuery,
	listContainersSummaryQuery,
	containerDetailSummaryQuery,
	containerCountersSummaryQuery,
	containerGaugeTimeseriesQuery,
	containerSumTimeseriesQuery,
	containerFacetsQuery,
	type ListContainersOpts,
	type ListContainersOutput,
	type ListContainersSummaryOutput,
	type ContainerSortKey,
	type ContainerScope,
	type ContainerDetailSummaryOpts,
	type ContainerDetailSummaryOutput,
	type ContainerCountersSummaryOpts,
	type ContainerCountersSummaryOutput,
	type ContainerGaugeTimeseriesOpts,
	type ContainerSumTimeseriesOpts,
	type ContainerTimeseriesOutput,
	type ContainerFacetsOutput,
} from "./queries/containers"
