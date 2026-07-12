import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	CommitSha,
	DeploymentEnvironment,
	FingerprintHash,
	ServiceName,
	ServiceNamespace,
	SpanId,
	SpanName,
	StatusCode,
	TraceId,
} from "../primitives"
import { QueryEngineExecuteRequest, QueryEngineExecuteResponse, TinybirdDateTime } from "../query-engine"
import { Authorization } from "./current-tenant"
import { warehouseHttpErrors } from "./warehouse"

// ---------------------------------------------------------------------------
// Dedicated endpoint schemas
// ---------------------------------------------------------------------------

export class SpanHierarchyRequest extends Schema.Class<SpanHierarchyRequest>("SpanHierarchyRequest")({
	traceId: TraceId,
	spanId: Schema.optional(SpanId),
	startTime: Schema.optional(TinybirdDateTime),
	endTime: Schema.optional(TinybirdDateTime),
}) {}

export class SpanHierarchyResponse extends Schema.Class<SpanHierarchyResponse>("SpanHierarchyResponse")({
	data: Schema.Array(
		Schema.Struct({
			traceId: TraceId,
			spanId: SpanId,
			parentSpanId: Schema.String,
			spanName: SpanName,
			serviceName: ServiceName,
			spanKind: Schema.String,
			durationMs: Schema.Number,
			startTime: Schema.String,
			statusCode: StatusCode,
			statusMessage: Schema.String,
			spanAttributes: Schema.String,
			resourceAttributes: Schema.String,
		}),
	),
}) {}

export class SpanDetailRequest extends Schema.Class<SpanDetailRequest>("SpanDetailRequest")({
	traceId: TraceId,
	spanId: SpanId,
	startTime: Schema.optional(TinybirdDateTime),
	endTime: Schema.optional(TinybirdDateTime),
}) {}

export class SpanDetailResponse extends Schema.Class<SpanDetailResponse>("SpanDetailResponse")({
	data: Schema.NullOr(
		Schema.Struct({
			traceId: TraceId,
			spanId: SpanId,
			spanAttributes: Schema.String,
			resourceAttributes: Schema.String,
		}),
	),
}) {}

const OptionalServiceNames = Schema.optional(Schema.Array(ServiceName))
const OptionalDeploymentEnvs = Schema.optional(Schema.Array(DeploymentEnvironment))
const OptionalServiceNamespaces = Schema.optional(Schema.Array(ServiceNamespace))
const OptionalCommitShas = Schema.optional(Schema.Array(CommitSha))
const OptionalFingerprintHashes = Schema.optional(Schema.Array(FingerprintHash))

export class ErrorsByTypeRequest extends Schema.Class<ErrorsByTypeRequest>("ErrorsByTypeRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	rootOnly: Schema.optional(Schema.Boolean),
	services: OptionalServiceNames,
	deploymentEnvs: OptionalDeploymentEnvs,
	fingerprintHashes: OptionalFingerprintHashes,
	limit: Schema.optional(Schema.Number),
}) {}

export class ErrorsByTypeResponse extends Schema.Class<ErrorsByTypeResponse>("ErrorsByTypeResponse")({
	data: Schema.Array(
		Schema.Struct({
			fingerprintHash: FingerprintHash,
			errorLabel: Schema.String,
			sampleMessage: Schema.String,
			count: Schema.Number,
			affectedServicesCount: Schema.Number,
			firstSeen: Schema.String,
			lastSeen: Schema.String,
		}),
	),
}) {}

export class ErrorsTimeseriesRequest extends Schema.Class<ErrorsTimeseriesRequest>("ErrorsTimeseriesRequest")(
	{
		startTime: TinybirdDateTime,
		endTime: TinybirdDateTime,
		fingerprintHash: FingerprintHash,
		services: OptionalServiceNames,
		bucketSeconds: Schema.optional(Schema.Number),
	},
) {}

export class ErrorsTimeseriesResponse extends Schema.Class<ErrorsTimeseriesResponse>(
	"ErrorsTimeseriesResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			count: Schema.Number,
		}),
	),
}) {}

export class ErrorsSummaryRequest extends Schema.Class<ErrorsSummaryRequest>("ErrorsSummaryRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	rootOnly: Schema.optional(Schema.Boolean),
	services: OptionalServiceNames,
	deploymentEnvs: OptionalDeploymentEnvs,
	fingerprintHashes: OptionalFingerprintHashes,
}) {}

export class ErrorsSummaryResponse extends Schema.Class<ErrorsSummaryResponse>("ErrorsSummaryResponse")({
	data: Schema.NullOr(
		Schema.Struct({
			totalErrors: Schema.Number,
			totalSpans: Schema.Number,
			errorRate: Schema.Number,
			affectedServicesCount: Schema.Number,
			affectedTracesCount: Schema.Number,
		}),
	),
}) {}

export class ErrorDetailTracesRequest extends Schema.Class<ErrorDetailTracesRequest>(
	"ErrorDetailTracesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	fingerprintHash: FingerprintHash,
	rootOnly: Schema.optional(Schema.Boolean),
	services: OptionalServiceNames,
	limit: Schema.optional(Schema.Number),
}) {}

export class ErrorDetailTracesResponse extends Schema.Class<ErrorDetailTracesResponse>(
	"ErrorDetailTracesResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			traceId: TraceId,
			startTime: Schema.String,
			durationMicros: Schema.Number,
			spanCount: Schema.Number,
			services: Schema.Array(ServiceName),
			rootSpanName: Schema.String,
			errorMessage: Schema.String,
		}),
	),
}) {}

export class ErrorRateByServiceRequest extends Schema.Class<ErrorRateByServiceRequest>(
	"ErrorRateByServiceRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}) {}

export class ErrorRateByServiceResponse extends Schema.Class<ErrorRateByServiceResponse>(
	"ErrorRateByServiceResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			serviceName: ServiceName,
			totalLogs: Schema.Number,
			errorLogs: Schema.Number,
			errorRate: Schema.Number,
		}),
	),
}) {}

export class ServiceOverviewRequest extends Schema.Class<ServiceOverviewRequest>("ServiceOverviewRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	environments: OptionalDeploymentEnvs,
	namespaces: OptionalServiceNamespaces,
	commitShas: OptionalCommitShas,
}) {}

export class ServiceOverviewResponse extends Schema.Class<ServiceOverviewResponse>("ServiceOverviewResponse")(
	{
		data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	},
) {}

export class ServiceHealthBaselineRequest extends Schema.Class<ServiceHealthBaselineRequest>(
	"ServiceHealthBaselineRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	environments: OptionalDeploymentEnvs,
	namespaces: OptionalServiceNamespaces,
}) {}

export class ServiceHealthBaselineResponse extends Schema.Class<ServiceHealthBaselineResponse>(
	"ServiceHealthBaselineResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			serviceName: ServiceName,
			serviceNamespace: Schema.String,
			environment: Schema.String,
			baselineP95LatencyMs: Schema.Number,
			baselineSpanCount: Schema.Number,
		}),
	),
}) {}

export class ServiceApdexRequest extends Schema.Class<ServiceApdexRequest>("ServiceApdexRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	serviceName: ServiceName,
	apdexThresholdMs: Schema.optional(Schema.Number),
	bucketSeconds: Schema.optional(Schema.Number),
}) {}

export class ServiceApdexResponse extends Schema.Class<ServiceApdexResponse>("ServiceApdexResponse")({
	data: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			totalCount: Schema.Number,
			satisfiedCount: Schema.Number,
			toleratingCount: Schema.Number,
			apdexScore: Schema.Number,
		}),
	),
}) {}

export class ServiceDependenciesRequest extends Schema.Class<ServiceDependenciesRequest>(
	"ServiceDependenciesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	deploymentEnv: Schema.optional(DeploymentEnvironment),
}) {}

export class ServiceDependenciesResponse extends Schema.Class<ServiceDependenciesResponse>(
	"ServiceDependenciesResponse",
)({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ServiceDbEdgesRequest extends Schema.Class<ServiceDbEdgesRequest>("ServiceDbEdgesRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	deploymentEnv: Schema.optional(DeploymentEnvironment),
}) {}

export class ServiceDbEdgesResponse extends Schema.Class<ServiceDbEdgesResponse>("ServiceDbEdgesResponse")({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

// Cloudflare direct-integration Workers analytics, one row per Worker
// pseudo-service (`cloudflare-worker/{script}`), overlaid onto matching
// instrumented service-map nodes. No `deploymentEnv` — the analytics poller's
// metrics carry no deployment.environment dimension. Response merges the
// counter + percentile rollups server-side; generic record shape mirrors
// ServiceDbEdgesResponse.
export class ServiceCloudflareStatsRequest extends Schema.Class<ServiceCloudflareStatsRequest>(
	"ServiceCloudflareStatsRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}) {}

export class ServiceCloudflareStatsResponse extends Schema.Class<ServiceCloudflareStatsResponse>(
	"ServiceCloudflareStatsResponse",
)({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

// PlanetScale scraped-metrics rollups for the service map: one row per
// database (or per branch of one database when `database` is set), overlaid
// onto trace-derived DB nodes. Same conventions as ServiceCloudflareStats —
// no `deploymentEnv` (scraped metrics carry none), generic record rows,
// gauges + connections merged server-side.
export class ServicePlanetScaleStatsRequest extends Schema.Class<ServicePlanetScaleStatsRequest>(
	"ServicePlanetScaleStatsRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	/** When set, returns per-branch rows scoped to this database. */
	database: Schema.optional(Schema.String),
}) {}

export class ServicePlanetScaleStatsResponse extends Schema.Class<ServicePlanetScaleStatsResponse>(
	"ServicePlanetScaleStatsResponse",
)({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

// PlanetScale infrastructure page (/infra/planetscale): bucketed per-database
// health timeseries from the scraped metrics.
export class PlanetScaleInfraTimeseriesRequest extends Schema.Class<PlanetScaleInfraTimeseriesRequest>(
	"PlanetScaleInfraTimeseriesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	bucketSeconds: Schema.Number,
	database: Schema.String,
}) {}

export class PlanetScaleInfraTimeseriesResponse extends Schema.Class<PlanetScaleInfraTimeseriesResponse>(
	"PlanetScaleInfraTimeseriesResponse",
)({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

// Cloudflare infrastructure page (/infra/cloudflare): per-zone HTTP edge
// analytics and per-Worker invocation analytics from the direct-integration
// poller's metrics. Same conventions as ServiceCloudflareStats — no
// `deploymentEnv` (the poller's metrics carry none), generic record rows,
// counters + percentiles merged server-side for the rollup endpoints.
export class CloudflareInfraZonesRequest extends Schema.Class<CloudflareInfraZonesRequest>(
	"CloudflareInfraZonesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}) {}

export class CloudflareInfraZonesResponse extends Schema.Class<CloudflareInfraZonesResponse>(
	"CloudflareInfraZonesResponse",
)({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class CloudflareInfraZoneTimeseriesRequest extends Schema.Class<CloudflareInfraZoneTimeseriesRequest>(
	"CloudflareInfraZoneTimeseriesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	bucketSeconds: Schema.Number,
}) {}

export class CloudflareInfraZoneTimeseriesResponse extends Schema.Class<CloudflareInfraZoneTimeseriesResponse>(
	"CloudflareInfraZoneTimeseriesResponse",
)({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

// Zone detail page: bucketed breakdowns by HTTP status class and cache
// status plus a latency-percentile timeseries, all scoped to one zone
// pseudo-service (`cloudflare/{zoneName}`). One round-trip for the page.
export class CloudflareInfraZoneDetailRequest extends Schema.Class<CloudflareInfraZoneDetailRequest>(
	"CloudflareInfraZoneDetailRequest",
)({
	serviceName: Schema.String,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	bucketSeconds: Schema.Number,
}) {}

export class CloudflareInfraZoneDetailResponse extends Schema.Class<CloudflareInfraZoneDetailResponse>(
	"CloudflareInfraZoneDetailResponse",
)({
	statusBuckets: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	cacheBuckets: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	latencyBuckets: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class CloudflareInfraWorkersRequest extends Schema.Class<CloudflareInfraWorkersRequest>(
	"CloudflareInfraWorkersRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}) {}

export class CloudflareInfraWorkersResponse extends Schema.Class<CloudflareInfraWorkersResponse>(
	"CloudflareInfraWorkersResponse",
)({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class CloudflareInfraWorkerTimeseriesRequest extends Schema.Class<CloudflareInfraWorkerTimeseriesRequest>(
	"CloudflareInfraWorkerTimeseriesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	bucketSeconds: Schema.Number,
}) {}

export class CloudflareInfraWorkerTimeseriesResponse extends Schema.Class<CloudflareInfraWorkerTimeseriesResponse>(
	"CloudflareInfraWorkerTimeseriesResponse",
)({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

// Zone detail page, extended sections: per-host breakdown, firewall/WAF
// events, and DNS analytics — each one round-trip bundling totals + buckets,
// scoped to one zone pseudo-service. Sections whose datasets are absent for
// the zone (plan/config-dependent) simply return empty arrays and the UI
// hides them, mirroring the latency-panel convention.
export class CloudflareInfraZoneHostsRequest extends Schema.Class<CloudflareInfraZoneHostsRequest>(
	"CloudflareInfraZoneHostsRequest",
)({
	serviceName: Schema.String,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	bucketSeconds: Schema.Number,
}) {}

export class CloudflareInfraZoneHostsResponse extends Schema.Class<CloudflareInfraZoneHostsResponse>(
	"CloudflareInfraZoneHostsResponse",
)({
	totals: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	buckets: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class CloudflareInfraZoneSecurityRequest extends Schema.Class<CloudflareInfraZoneSecurityRequest>(
	"CloudflareInfraZoneSecurityRequest",
)({
	serviceName: Schema.String,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	bucketSeconds: Schema.Number,
}) {}

export class CloudflareInfraZoneSecurityResponse extends Schema.Class<CloudflareInfraZoneSecurityResponse>(
	"CloudflareInfraZoneSecurityResponse",
)({
	buckets: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	top: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class CloudflareInfraZoneDnsRequest extends Schema.Class<CloudflareInfraZoneDnsRequest>(
	"CloudflareInfraZoneDnsRequest",
)({
	serviceName: Schema.String,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	bucketSeconds: Schema.Number,
}) {}

export class CloudflareInfraZoneDnsResponse extends Schema.Class<CloudflareInfraZoneDnsResponse>(
	"CloudflareInfraZoneDnsResponse",
)({
	buckets: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	names: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

// Workers-platform resources for the /infra/cloudflare index page: Queues
// (backlog/concurrency gauges under `cloudflare-queue/{id}`) and Durable
// Objects (counters on the implementing `cloudflare-worker/{script}`).
export class CloudflareInfraPlatformResourcesRequest extends Schema.Class<CloudflareInfraPlatformResourcesRequest>(
	"CloudflareInfraPlatformResourcesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}) {}

export class CloudflareInfraPlatformResourcesResponse extends Schema.Class<CloudflareInfraPlatformResourcesResponse>(
	"CloudflareInfraPlatformResourcesResponse",
)({
	queues: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	durableObjects: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ServiceExternalEdgesRequest extends Schema.Class<ServiceExternalEdgesRequest>(
	"ServiceExternalEdgesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	serviceName: ServiceName,
	deploymentEnv: Schema.optional(DeploymentEnvironment),
}) {}

// Service-scoped variants for the service-detail page's Dependencies tab.
// Same response shape as the org-wide ServiceDependencies* / ServiceDbEdges*
// pair — adding `serviceName` lets the query pre-filter at the source instead
// of fetching every org-wide edge and discarding ~95% of rows in the client.
export class ServiceDependenciesForServiceRequest extends Schema.Class<ServiceDependenciesForServiceRequest>(
	"ServiceDependenciesForServiceRequest",
)({
	serviceName: ServiceName,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	deploymentEnv: Schema.optional(DeploymentEnvironment),
}) {}

export class ServiceDbEdgesForServiceRequest extends Schema.Class<ServiceDbEdgesForServiceRequest>(
	"ServiceDbEdgesForServiceRequest",
)({
	serviceName: ServiceName,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	deploymentEnv: Schema.optional(DeploymentEnvironment),
}) {}

// ---------------------------------------------------------------------------
// Service-detail page bundles
//
// The service-detail page used to fan out N independent Worker requests on
// load — each re-resolving per-org ClickHouse config and paying its own
// browser→Worker round-trip. These bundle endpoints run a tab's queries in a
// single Worker invocation (config resolved once, sub-queries in parallel),
// collapsing the round-trips to 1.
// ---------------------------------------------------------------------------

export class ServiceDetailOverviewRequest extends Schema.Class<ServiceDetailOverviewRequest>(
	"ServiceDetailOverviewRequest",
)({
	serviceName: ServiceName,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	// Pre-built all-metrics timeseries request. The single source of truth lives
	// on the client (`makeAllMetricsTimeseriesRequest`, which owns bucket sizing,
	// group-by and the env/commit filters); the handler forwards this verbatim to
	// `queryEngine.execute` rather than reconstructing it server-side.
	timeseries: QueryEngineExecuteRequest,
	// Bucket size for the releases-timeline sub-query (client-computed alongside
	// the timeseries bucket).
	releasesBucketSeconds: Schema.optional(Schema.Number),
}) {}

export class ServiceDetailOverviewResponse extends Schema.Class<ServiceDetailOverviewResponse>(
	"ServiceDetailOverviewResponse",
)({
	timeseries: QueryEngineExecuteResponse,
	releases: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			commitSha: CommitSha,
			count: Schema.Number,
		}),
	),
	// Distinct non-empty deployment environments this service reports in the
	// window — feeds the environment switcher dropdown (previously an all-services
	// overview scan).
	environments: Schema.Array(Schema.String),
}) {}

export class ServiceDependenciesBundleRequest extends Schema.Class<ServiceDependenciesBundleRequest>(
	"ServiceDependenciesBundleRequest",
)({
	serviceName: ServiceName,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	deploymentEnv: Schema.optional(DeploymentEnvironment),
}) {}

export class ServiceDependenciesBundleResponse extends Schema.Class<ServiceDependenciesBundleResponse>(
	"ServiceDependenciesBundleResponse",
)({
	dependencies: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	dbEdges: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	externalEdges: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ServiceDbQuerySummaryRequest extends Schema.Class<ServiceDbQuerySummaryRequest>(
	"ServiceDbQuerySummaryRequest",
)({
	dbSystem: Schema.String,
	// Scope to one database identity; omitted = all databases of the system,
	// "" = the legacy/unknown node (see ServiceDbQuerySummaryParams).
	dbNamespace: Schema.optional(Schema.String),
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	sourceService: Schema.optional(ServiceName),
	deploymentEnv: Schema.optional(DeploymentEnvironment),
	bucketSeconds: Schema.optional(Schema.Number),
	topN: Schema.optional(Schema.Number),
}) {}

const ServiceDbQuerySummaryData = Schema.Struct({
	queryCount: Schema.Number,
	estimatedQueryCount: Schema.Number,
	errorCount: Schema.Number,
	estimatedErrorCount: Schema.Number,
	errorRate: Schema.Number,
	avgDurationMs: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
	activeServiceCount: Schema.Number,
})

const ServiceDbQueryTimeseriesPoint = Schema.Struct({
	bucket: Schema.String,
	queryCount: Schema.Number,
	estimatedQueryCount: Schema.Number,
	errorCount: Schema.Number,
	errorRate: Schema.Number,
	avgDurationMs: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
})

const ServiceDbTopQuery = Schema.Struct({
	queryKey: Schema.String,
	queryLabel: Schema.String,
	sampleStatement: Schema.String,
	sampleService: Schema.String,
	serviceCount: Schema.Number,
	queryCount: Schema.Number,
	estimatedQueryCount: Schema.Number,
	errorCount: Schema.Number,
	errorRate: Schema.Number,
	avgDurationMs: Schema.Number,
	p50DurationMs: Schema.Number,
	p95DurationMs: Schema.Number,
	lastSeen: Schema.String,
})

export class ServiceDbQuerySummaryResponse extends Schema.Class<ServiceDbQuerySummaryResponse>(
	"ServiceDbQuerySummaryResponse",
)({
	summary: Schema.NullOr(ServiceDbQuerySummaryData),
	timeseries: Schema.Array(ServiceDbQueryTimeseriesPoint),
	topQueries: Schema.Array(ServiceDbTopQuery),
}) {}

export class ServiceExternalEdgesResponse extends Schema.Class<ServiceExternalEdgesResponse>(
	"ServiceExternalEdgesResponse",
)({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

const ServicePlatformLiteral = Schema.Literals(["kubernetes", "cloudflare", "lambda", "web", "unknown"])

export class ServicePlatformsRequest extends Schema.Class<ServicePlatformsRequest>("ServicePlatformsRequest")(
	{
		startTime: TinybirdDateTime,
		endTime: TinybirdDateTime,
		deploymentEnv: Schema.optional(DeploymentEnvironment),
	},
) {}

export class ServicePlatformsResponse extends Schema.Class<ServicePlatformsResponse>(
	"ServicePlatformsResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			serviceName: ServiceName,
			platform: ServicePlatformLiteral,
			k8sCluster: Schema.String,
			cloudPlatform: Schema.String,
			cloudProvider: Schema.String,
			faasName: Schema.String,
			mapleSdkType: Schema.String,
			processRuntimeName: Schema.String,
		}),
	),
}) {}

const ServiceWorkloadKindLiteral = Schema.Literals(["deployment", "statefulset", "daemonset", "unknown"])

export class ServiceWorkloadsRequest extends Schema.Class<ServiceWorkloadsRequest>("ServiceWorkloadsRequest")(
	{
		startTime: TinybirdDateTime,
		endTime: TinybirdDateTime,
		services: Schema.Array(ServiceName),
	},
) {}

export class ServiceWorkloadsResponse extends Schema.Class<ServiceWorkloadsResponse>(
	"ServiceWorkloadsResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			serviceName: ServiceName,
			workloadKind: ServiceWorkloadKindLiteral,
			workloadName: Schema.String,
			namespace: Schema.String,
			clusterName: Schema.String,
			podCount: Schema.Number,
			avgCpuLimitUtilization: Schema.NullOr(Schema.Number),
			avgMemoryLimitUtilization: Schema.NullOr(Schema.Number),
		}),
	),
}) {}

export class ServiceUsageRequest extends Schema.Class<ServiceUsageRequest>("ServiceUsageRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	service: Schema.optional(ServiceName),
	// When both are set, the usage query also returns per-service `previous*`
	// totals for the [previousStartTime, previousEndTime] window in the SAME scan
	// (delta chips) instead of the caller issuing a second request.
	previousStartTime: Schema.optional(TinybirdDateTime),
	previousEndTime: Schema.optional(TinybirdDateTime),
}) {}

export class ServiceUsageResponse extends Schema.Class<ServiceUsageResponse>("ServiceUsageResponse")({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ListLogsRequest extends Schema.Class<ListLogsRequest>("ListLogsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	service: Schema.optional(ServiceName),
	severity: Schema.optional(Schema.String),
	minSeverity: Schema.optional(Schema.Number),
	traceId: Schema.optional(Schema.String),
	spanId: Schema.optional(Schema.String),
	cursor: Schema.optional(Schema.String),
	search: Schema.optional(Schema.String),
	deploymentEnv: Schema.optional(DeploymentEnvironment),
	deploymentEnvMatchMode: Schema.optional(Schema.Literal("contains")),
	namespace: Schema.optional(ServiceNamespace),
	namespaceMatchMode: Schema.optional(Schema.Literal("contains")),
	limit: Schema.optional(Schema.Number),
}) {}

export class ListLogsResponse extends Schema.Class<ListLogsResponse>("ListLogsResponse")({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

// Exact-match lookup of one log by its composite key (logs have no primary id).
// `timestamp` is the raw ClickHouse DateTime64 string and carries sub-second
// precision (`YYYY-MM-DD HH:mm:ss.fffffffff`), so it is a plain string rather
// than `TinybirdDateTime` (which only matches second-level precision).
export class GetLogRequest extends Schema.Class<GetLogRequest>("GetLogRequest")({
	timestamp: Schema.String,
	serviceName: ServiceName,
	traceId: Schema.optional(Schema.String),
	spanId: Schema.optional(Schema.String),
}) {}

// `data` holds 0 or 1 rows — the requested log, or nothing if it aged out.
export class GetLogResponse extends Schema.Class<GetLogResponse>("GetLogResponse")({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ListMetricsRequest extends Schema.Class<ListMetricsRequest>("ListMetricsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	service: Schema.optional(ServiceName),
	metricType: Schema.optional(Schema.String),
	search: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
}) {}

export class ListMetricsResponse extends Schema.Class<ListMetricsResponse>("ListMetricsResponse")({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class MetricsSummaryRequest extends Schema.Class<MetricsSummaryRequest>("MetricsSummaryRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	service: Schema.optional(ServiceName),
}) {}

export class MetricsSummaryResponse extends Schema.Class<MetricsSummaryResponse>("MetricsSummaryResponse")({
	data: Schema.Array(
		Schema.Struct({
			metricType: Schema.String,
			metricCount: Schema.Number,
			dataPointCount: Schema.Number,
		}),
	),
}) {}

// ---------------------------------------------------------------------------
// Infrastructure (host-centric)
// ---------------------------------------------------------------------------

export class ListHostsRequest extends Schema.Class<ListHostsRequest>("ListHostsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	search: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
}) {}

const HostRow = Schema.Struct({
	hostName: Schema.String,
	osType: Schema.String,
	hostArch: Schema.String,
	cloudProvider: Schema.String,
	lastSeen: Schema.String,
	cpuPct: Schema.Number,
	memoryPct: Schema.Number,
	diskPct: Schema.Number,
	load15: Schema.Number,
})

export class ListHostsResponse extends Schema.Class<ListHostsResponse>("ListHostsResponse")({
	data: Schema.Array(HostRow),
}) {}

export class HostDetailSummaryRequest extends Schema.Class<HostDetailSummaryRequest>(
	"HostDetailSummaryRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	hostName: Schema.String,
}) {}

export class HostDetailSummaryResponse extends Schema.Class<HostDetailSummaryResponse>(
	"HostDetailSummaryResponse",
)({
	data: Schema.NullOr(
		Schema.Struct({
			hostName: Schema.String,
			osType: Schema.String,
			hostArch: Schema.String,
			cloudProvider: Schema.String,
			cloudRegion: Schema.String,
			firstSeen: Schema.String,
			lastSeen: Schema.String,
			cpuPct: Schema.Number,
			memoryPct: Schema.Number,
			diskPct: Schema.Number,
			load15: Schema.Number,
		}),
	),
}) {}

export class HostInfraTimeseriesRequest extends Schema.Class<HostInfraTimeseriesRequest>(
	"HostInfraTimeseriesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	hostName: Schema.String,
	metric: Schema.Literals(["cpu", "memory", "filesystem", "network", "load15"]),
	bucketSeconds: Schema.optional(Schema.Number),
}) {}

export class HostInfraTimeseriesResponse extends Schema.Class<HostInfraTimeseriesResponse>(
	"HostInfraTimeseriesResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			attributeValue: Schema.String,
			value: Schema.Number,
		}),
	),
	groupByAttributeKey: Schema.optional(Schema.String),
	unit: Schema.Literals(["percent", "load", "bytes_per_second"]),
}) {}

export class FleetUtilizationTimeseriesRequest extends Schema.Class<FleetUtilizationTimeseriesRequest>(
	"FleetUtilizationTimeseriesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	bucketSeconds: Schema.optional(Schema.Number),
}) {}

export class FleetUtilizationTimeseriesResponse extends Schema.Class<FleetUtilizationTimeseriesResponse>(
	"FleetUtilizationTimeseriesResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			avgCpu: Schema.Number,
			avgMemory: Schema.Number,
			activeHosts: Schema.Number,
		}),
	),
}) {}

// ---------------------------------------------------------------------------
// Kubernetes (pods / nodes / workloads)
// ---------------------------------------------------------------------------

const WorkloadKindLiteral = Schema.Literals(["deployment", "statefulset", "daemonset"])

const StringArray = Schema.Array(Schema.String)

const FacetRow = Schema.Struct({
	name: Schema.String,
	count: Schema.Number,
})

export class ListPodsRequest extends Schema.Class<ListPodsRequest>("ListPodsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	search: Schema.optional(Schema.String),
	podNames: Schema.optional(StringArray),
	namespaces: Schema.optional(StringArray),
	nodeNames: Schema.optional(StringArray),
	clusters: Schema.optional(StringArray),
	deployments: Schema.optional(StringArray),
	statefulsets: Schema.optional(StringArray),
	daemonsets: Schema.optional(StringArray),
	jobs: Schema.optional(StringArray),
	environments: Schema.optional(StringArray),
	computeTypes: Schema.optional(StringArray),
	workloadKind: Schema.optional(WorkloadKindLiteral),
	workloadName: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
}) {}

const PodRow = Schema.Struct({
	podName: Schema.String,
	namespace: Schema.String,
	nodeName: Schema.String,
	clusterName: Schema.String,
	environment: Schema.String,
	deploymentName: Schema.String,
	statefulsetName: Schema.String,
	daemonsetName: Schema.String,
	jobName: Schema.String,
	qosClass: Schema.String,
	podUid: Schema.String,
	computeType: Schema.String,
	lastSeen: Schema.String,
	cpuUsage: Schema.Number,
	cpuLimitPct: Schema.Number,
	memoryLimitPct: Schema.Number,
	cpuRequestPct: Schema.Number,
	memoryRequestPct: Schema.Number,
})

export class ListPodsResponse extends Schema.Class<ListPodsResponse>("ListPodsResponse")({
	data: Schema.Array(PodRow),
}) {}

export class PodFacetsRequest extends Schema.Class<PodFacetsRequest>("PodFacetsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	search: Schema.optional(Schema.String),
	podNames: Schema.optional(StringArray),
	namespaces: Schema.optional(StringArray),
	nodeNames: Schema.optional(StringArray),
	clusters: Schema.optional(StringArray),
	deployments: Schema.optional(StringArray),
	statefulsets: Schema.optional(StringArray),
	daemonsets: Schema.optional(StringArray),
	jobs: Schema.optional(StringArray),
	environments: Schema.optional(StringArray),
	computeTypes: Schema.optional(StringArray),
}) {}

export class PodFacetsResponse extends Schema.Class<PodFacetsResponse>("PodFacetsResponse")({
	data: Schema.Struct({
		pods: Schema.Array(FacetRow),
		namespaces: Schema.Array(FacetRow),
		nodes: Schema.Array(FacetRow),
		clusters: Schema.Array(FacetRow),
		deployments: Schema.Array(FacetRow),
		statefulsets: Schema.Array(FacetRow),
		daemonsets: Schema.Array(FacetRow),
		jobs: Schema.Array(FacetRow),
		environments: Schema.Array(FacetRow),
		computeTypes: Schema.Array(FacetRow),
	}),
}) {}

export class PodDetailSummaryRequest extends Schema.Class<PodDetailSummaryRequest>("PodDetailSummaryRequest")(
	{
		startTime: TinybirdDateTime,
		endTime: TinybirdDateTime,
		podName: Schema.String,
		namespace: Schema.optional(Schema.String),
	},
) {}

export class PodDetailSummaryResponse extends Schema.Class<PodDetailSummaryResponse>(
	"PodDetailSummaryResponse",
)({
	data: Schema.NullOr(
		Schema.Struct({
			podName: Schema.String,
			namespace: Schema.String,
			nodeName: Schema.String,
			deploymentName: Schema.String,
			statefulsetName: Schema.String,
			daemonsetName: Schema.String,
			qosClass: Schema.String,
			podUid: Schema.String,
			computeType: Schema.String,
			podStartTime: Schema.String,
			firstSeen: Schema.String,
			lastSeen: Schema.String,
			cpuUsage: Schema.Number,
			cpuLimitPct: Schema.Number,
			memoryLimitPct: Schema.Number,
			cpuRequestPct: Schema.Number,
			memoryRequestPct: Schema.Number,
		}),
	),
}) {}

export class PodInfraTimeseriesRequest extends Schema.Class<PodInfraTimeseriesRequest>(
	"PodInfraTimeseriesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	podName: Schema.String,
	namespace: Schema.optional(Schema.String),
	metric: Schema.Literals(["cpu_usage", "cpu_limit", "cpu_request", "memory_limit", "memory_request"]),
	bucketSeconds: Schema.optional(Schema.Number),
}) {}

export class PodInfraTimeseriesResponse extends Schema.Class<PodInfraTimeseriesResponse>(
	"PodInfraTimeseriesResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			attributeValue: Schema.String,
			value: Schema.Number,
		}),
	),
	unit: Schema.Literals(["percent", "cores"]),
}) {}

export class ListNodesRequest extends Schema.Class<ListNodesRequest>("ListNodesRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	search: Schema.optional(Schema.String),
	nodeNames: Schema.optional(StringArray),
	clusters: Schema.optional(StringArray),
	environments: Schema.optional(StringArray),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
}) {}

const NodeRow = Schema.Struct({
	nodeName: Schema.String,
	nodeUid: Schema.String,
	clusterName: Schema.String,
	environment: Schema.String,
	kubeletVersion: Schema.String,
	lastSeen: Schema.String,
	cpuUsage: Schema.Number,
	uptime: Schema.Number,
})

export class ListNodesResponse extends Schema.Class<ListNodesResponse>("ListNodesResponse")({
	data: Schema.Array(NodeRow),
}) {}

export class NodeFacetsRequest extends Schema.Class<NodeFacetsRequest>("NodeFacetsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	search: Schema.optional(Schema.String),
	nodeNames: Schema.optional(StringArray),
	clusters: Schema.optional(StringArray),
	environments: Schema.optional(StringArray),
}) {}

export class NodeFacetsResponse extends Schema.Class<NodeFacetsResponse>("NodeFacetsResponse")({
	data: Schema.Struct({
		nodes: Schema.Array(FacetRow),
		clusters: Schema.Array(FacetRow),
		environments: Schema.Array(FacetRow),
	}),
}) {}

export class NodeDetailSummaryRequest extends Schema.Class<NodeDetailSummaryRequest>(
	"NodeDetailSummaryRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	nodeName: Schema.String,
}) {}

export class NodeDetailSummaryResponse extends Schema.Class<NodeDetailSummaryResponse>(
	"NodeDetailSummaryResponse",
)({
	data: Schema.NullOr(
		Schema.Struct({
			nodeName: Schema.String,
			nodeUid: Schema.String,
			kubeletVersion: Schema.String,
			containerRuntime: Schema.String,
			firstSeen: Schema.String,
			lastSeen: Schema.String,
			cpuUsage: Schema.Number,
			uptime: Schema.Number,
		}),
	),
}) {}

export class NodeInfraTimeseriesRequest extends Schema.Class<NodeInfraTimeseriesRequest>(
	"NodeInfraTimeseriesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	nodeName: Schema.String,
	metric: Schema.Literals(["cpu_usage", "uptime"]),
	bucketSeconds: Schema.optional(Schema.Number),
}) {}

export class NodeInfraTimeseriesResponse extends Schema.Class<NodeInfraTimeseriesResponse>(
	"NodeInfraTimeseriesResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			attributeValue: Schema.String,
			value: Schema.Number,
		}),
	),
	unit: Schema.Literals(["cores", "seconds"]),
}) {}

export class ListWorkloadsRequest extends Schema.Class<ListWorkloadsRequest>("ListWorkloadsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	kind: WorkloadKindLiteral,
	search: Schema.optional(Schema.String),
	workloadNames: Schema.optional(StringArray),
	namespaces: Schema.optional(StringArray),
	clusters: Schema.optional(StringArray),
	environments: Schema.optional(StringArray),
	computeTypes: Schema.optional(StringArray),
	limit: Schema.optional(Schema.Number),
	offset: Schema.optional(Schema.Number),
}) {}

const WorkloadRow = Schema.Struct({
	workloadName: Schema.String,
	namespace: Schema.String,
	clusterName: Schema.String,
	environment: Schema.String,
	podCount: Schema.Number,
	lastSeen: Schema.String,
	avgCpuLimitPct: Schema.Number,
	avgMemoryLimitPct: Schema.Number,
	avgCpuUsage: Schema.Number,
})

export class ListWorkloadsResponse extends Schema.Class<ListWorkloadsResponse>("ListWorkloadsResponse")({
	data: Schema.Array(WorkloadRow),
}) {}

export class WorkloadFacetsRequest extends Schema.Class<WorkloadFacetsRequest>("WorkloadFacetsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	kind: WorkloadKindLiteral,
	search: Schema.optional(Schema.String),
	workloadNames: Schema.optional(StringArray),
	namespaces: Schema.optional(StringArray),
	clusters: Schema.optional(StringArray),
	environments: Schema.optional(StringArray),
	computeTypes: Schema.optional(StringArray),
}) {}

export class WorkloadFacetsResponse extends Schema.Class<WorkloadFacetsResponse>("WorkloadFacetsResponse")({
	data: Schema.Struct({
		workloads: Schema.Array(FacetRow),
		namespaces: Schema.Array(FacetRow),
		clusters: Schema.Array(FacetRow),
		environments: Schema.Array(FacetRow),
		computeTypes: Schema.Array(FacetRow),
	}),
}) {}

export class WorkloadDetailSummaryRequest extends Schema.Class<WorkloadDetailSummaryRequest>(
	"WorkloadDetailSummaryRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	kind: WorkloadKindLiteral,
	workloadName: Schema.String,
	namespace: Schema.optional(Schema.String),
}) {}

export class WorkloadDetailSummaryResponse extends Schema.Class<WorkloadDetailSummaryResponse>(
	"WorkloadDetailSummaryResponse",
)({
	data: Schema.NullOr(
		Schema.Struct({
			workloadName: Schema.String,
			kind: WorkloadKindLiteral,
			namespace: Schema.String,
			podCount: Schema.Number,
			firstSeen: Schema.String,
			lastSeen: Schema.String,
			avgCpuLimitPct: Schema.Number,
			avgMemoryLimitPct: Schema.Number,
			avgCpuUsage: Schema.Number,
		}),
	),
}) {}

export class WorkloadInfraTimeseriesRequest extends Schema.Class<WorkloadInfraTimeseriesRequest>(
	"WorkloadInfraTimeseriesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	kind: WorkloadKindLiteral,
	workloadName: Schema.String,
	namespace: Schema.optional(Schema.String),
	metric: Schema.Literals(["cpu_usage", "cpu_limit", "memory_limit"]),
	groupByPod: Schema.optional(Schema.Boolean),
	bucketSeconds: Schema.optional(Schema.Number),
}) {}

export class WorkloadInfraTimeseriesResponse extends Schema.Class<WorkloadInfraTimeseriesResponse>(
	"WorkloadInfraTimeseriesResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			bucket: Schema.String,
			attributeValue: Schema.String,
			value: Schema.Number,
		}),
	),
	unit: Schema.Literals(["percent", "cores"]),
}) {}

// ---------------------------------------------------------------------------
// Query Builder execute (used by dashboards' custom_query_builder_* widgets)
// ---------------------------------------------------------------------------

const QueryBuilderAddOnsSchema = Schema.Struct({
	groupBy: Schema.Boolean,
	having: Schema.Boolean,
	orderBy: Schema.Boolean,
	limit: Schema.Boolean,
	legend: Schema.Boolean,
})

// Fields shared by every query-draft source. Metric-specific fields live only
// on the metrics variant below — traces/logs queries never carry them.
const queryDraftBaseFields = {
	id: Schema.String,
	name: Schema.String,
	enabled: Schema.optional(Schema.Boolean),
	hidden: Schema.optional(Schema.Boolean),
	whereClause: Schema.optional(Schema.String),
	aggregation: Schema.String,
	stepInterval: Schema.optional(Schema.String),
	orderByDirection: Schema.optional(Schema.Literals(["desc", "asc"])),
	addOns: Schema.optional(QueryBuilderAddOnsSchema),
	groupBy: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
	having: Schema.optional(Schema.String),
	orderBy: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.String),
	// Opt-in top-N series cap for group-by timeseries charts (entered as a string
	// in the builder; parsed to a positive integer when lowering to a QuerySpec).
	seriesLimit: Schema.optional(Schema.String),
	legend: Schema.optional(Schema.String),
}

export const TracesQueryDraftSchema = Schema.Struct({
	...queryDraftBaseFields,
	dataSource: Schema.Literal("traces"),
	// A non-empty `valueField` (e.g. "attr.result.rowCount") switches the traces
	// query into numeric-attribute aggregation mode: `aggregation` becomes a
	// numeric function over that span attribute instead of a duration-based metric.
	valueField: Schema.optional(Schema.String),
})

export const LogsQueryDraftSchema = Schema.Struct({
	...queryDraftBaseFields,
	dataSource: Schema.Literal("logs"),
})

export const MetricsQueryDraftSchema = Schema.Struct({
	...queryDraftBaseFields,
	dataSource: Schema.Literal("metrics"),
	signalSource: Schema.optional(Schema.Literals(["default", "meter"])),
	metricName: Schema.optional(Schema.String),
	metricType: Schema.optional(Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"])),
	isMonotonic: Schema.optional(Schema.Boolean),
})

export const QueryBuilderQueryDraftSchema = Schema.Union([
	TracesQueryDraftSchema,
	LogsQueryDraftSchema,
	MetricsQueryDraftSchema,
])
export type QueryBuilderQueryDraftPayload = Schema.Schema.Type<typeof QueryBuilderQueryDraftSchema>

export class ExecuteQueryBuilderRequest extends Schema.Class<ExecuteQueryBuilderRequest>(
	"ExecuteQueryBuilderRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	kind: Schema.Literals(["timeseries", "breakdown"]),
	queries: Schema.mutable(Schema.Array(QueryBuilderQueryDraftSchema)),
}) {}

const QueryBuilderTimeseriesPoint = Schema.Struct({
	bucket: Schema.String,
	series: Schema.Record(Schema.String, Schema.Number),
})

const QueryBuilderBreakdownItem = Schema.Struct({
	name: Schema.String,
	value: Schema.Number,
})

export class ExecuteQueryBuilderResponse extends Schema.Class<ExecuteQueryBuilderResponse>(
	"ExecuteQueryBuilderResponse",
)({
	result: Schema.Union([
		Schema.Struct({
			kind: Schema.Literal("timeseries"),
			data: Schema.Array(QueryBuilderTimeseriesPoint),
		}),
		Schema.Struct({
			kind: Schema.Literal("breakdown"),
			data: Schema.Array(QueryBuilderBreakdownItem),
		}),
	]),
	warnings: Schema.optional(Schema.Array(Schema.String)),
}) {}

// ---------------------------------------------------------------------------
// Raw SQL chart (Hyperdx-style — user-authored ClickHouse SQL with macros)
// ---------------------------------------------------------------------------

export const RawSqlDisplayType = Schema.Literals([
	"line",
	"area",
	"bar",
	"table",
	"stat",
	"pie",
	"histogram",
	"heatmap",
	"funnel",
])
export type RawSqlDisplayType = Schema.Schema.Type<typeof RawSqlDisplayType>

export class RawSqlExecuteRequest extends Schema.Class<RawSqlExecuteRequest>("RawSqlExecuteRequest")({
	sql: Schema.String,
	displayType: RawSqlDisplayType,
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	granularitySeconds: Schema.optional(Schema.Number),
}) {}

export class RawSqlExecuteResponse extends Schema.Class<RawSqlExecuteResponse>("RawSqlExecuteResponse")({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	meta: Schema.Struct({
		rowCount: Schema.Number,
		columns: Schema.Array(Schema.String),
		granularitySeconds: Schema.Number,
	}),
}) {}

export class RawSqlValidationError extends Schema.TaggedErrorClass<RawSqlValidationError>()(
	"@maple/http/errors/RawSqlValidationError",
	{
		code: Schema.Literals([
			"MissingOrgFilter",
			"InvalidMacro",
			"DisallowedStatement",
			"MultipleStatements",
			"UnresolvedMacro",
		]),
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class QueryEngineValidationError extends Schema.TaggedErrorClass<QueryEngineValidationError>()(
	"@maple/http/errors/QueryEngineValidationError",
	{
		message: Schema.String,
		details: Schema.Array(Schema.String),
	},
	{ httpApiStatus: 400 },
) {}

export class QueryEngineExecutionError extends Schema.TaggedErrorClass<QueryEngineExecutionError>()(
	"@maple/http/errors/QueryEngineExecutionError",
	{
		message: Schema.String,
		causeMessage: Schema.optional(Schema.String),
		pipeName: Schema.optional(Schema.String),
	},
	{ httpApiStatus: 502 },
) {}

export class QueryEngineTimeoutError extends Schema.TaggedErrorClass<QueryEngineTimeoutError>()(
	"@maple/http/errors/QueryEngineTimeoutError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 504 },
) {}

// Shared arrays — passing the same reference to every endpoint avoids
// constructing dozens of identical inline literals at module load (each one
// drives Effect's HttpApi to build a Schema union internally). This is a perf
// nicety, not a hard requirement: the script-startup CPU concern (Cloudflare
// error 10021) is mitigated at the source by `apps/api/src/worker.ts` lazy-
// importing the route graph, so the Schema ASTs never build during upload
// validation.
const queryEngineEndpointErrors = [
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
	...warehouseHttpErrors,
] as const

const validatedQueryEndpointErrors = [
	QueryEngineValidationError,
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
	...warehouseHttpErrors,
] as const

export class QueryEngineApiGroup extends HttpApiGroup.make("queryEngine")
	.add(
		HttpApiEndpoint.post("execute", "/execute", {
			payload: QueryEngineExecuteRequest,
			success: QueryEngineExecuteResponse,
			error: validatedQueryEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("spanHierarchy", "/span-hierarchy", {
			payload: SpanHierarchyRequest,
			success: SpanHierarchyResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("spanDetail", "/span-detail", {
			payload: SpanDetailRequest,
			success: SpanDetailResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("errorsByType", "/errors-by-type", {
			payload: ErrorsByTypeRequest,
			success: ErrorsByTypeResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("errorsTimeseries", "/errors-timeseries", {
			payload: ErrorsTimeseriesRequest,
			success: ErrorsTimeseriesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("errorsSummary", "/errors-summary", {
			payload: ErrorsSummaryRequest,
			success: ErrorsSummaryResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("errorDetailTraces", "/error-detail-traces", {
			payload: ErrorDetailTracesRequest,
			success: ErrorDetailTracesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("errorRateByService", "/error-rate-by-service", {
			payload: ErrorRateByServiceRequest,
			success: ErrorRateByServiceResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceOverview", "/service-overview", {
			payload: ServiceOverviewRequest,
			success: ServiceOverviewResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceHealthBaseline", "/service-health-baseline", {
			payload: ServiceHealthBaselineRequest,
			success: ServiceHealthBaselineResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceApdex", "/service-apdex", {
			payload: ServiceApdexRequest,
			success: ServiceApdexResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceDependencies", "/service-dependencies", {
			payload: ServiceDependenciesRequest,
			success: ServiceDependenciesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceDependenciesForService", "/service-dependencies-for-service", {
			payload: ServiceDependenciesForServiceRequest,
			success: ServiceDependenciesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceDbEdges", "/service-db-edges", {
			payload: ServiceDbEdgesRequest,
			success: ServiceDbEdgesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceDbEdgesForService", "/service-db-edges-for-service", {
			payload: ServiceDbEdgesForServiceRequest,
			success: ServiceDbEdgesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceCloudflareStats", "/service-cloudflare-stats", {
			payload: ServiceCloudflareStatsRequest,
			success: ServiceCloudflareStatsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("servicePlanetScaleStats", "/service-planetscale-stats", {
			payload: ServicePlanetScaleStatsRequest,
			success: ServicePlanetScaleStatsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("planetscaleInfraTimeseries", "/planetscale-infra-timeseries", {
			payload: PlanetScaleInfraTimeseriesRequest,
			success: PlanetScaleInfraTimeseriesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cloudflareInfraZones", "/cloudflare-infra-zones", {
			payload: CloudflareInfraZonesRequest,
			success: CloudflareInfraZonesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cloudflareInfraZoneTimeseries", "/cloudflare-infra-zone-timeseries", {
			payload: CloudflareInfraZoneTimeseriesRequest,
			success: CloudflareInfraZoneTimeseriesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cloudflareInfraZoneDetail", "/cloudflare-infra-zone-detail", {
			payload: CloudflareInfraZoneDetailRequest,
			success: CloudflareInfraZoneDetailResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cloudflareInfraZoneHosts", "/cloudflare-infra-zone-hosts", {
			payload: CloudflareInfraZoneHostsRequest,
			success: CloudflareInfraZoneHostsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cloudflareInfraZoneSecurity", "/cloudflare-infra-zone-security", {
			payload: CloudflareInfraZoneSecurityRequest,
			success: CloudflareInfraZoneSecurityResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cloudflareInfraZoneDns", "/cloudflare-infra-zone-dns", {
			payload: CloudflareInfraZoneDnsRequest,
			success: CloudflareInfraZoneDnsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cloudflareInfraPlatformResources", "/cloudflare-infra-platform-resources", {
			payload: CloudflareInfraPlatformResourcesRequest,
			success: CloudflareInfraPlatformResourcesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cloudflareInfraWorkers", "/cloudflare-infra-workers", {
			payload: CloudflareInfraWorkersRequest,
			success: CloudflareInfraWorkersResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("cloudflareInfraWorkerTimeseries", "/cloudflare-infra-worker-timeseries", {
			payload: CloudflareInfraWorkerTimeseriesRequest,
			success: CloudflareInfraWorkerTimeseriesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceDetailOverview", "/service-detail-overview", {
			payload: ServiceDetailOverviewRequest,
			success: ServiceDetailOverviewResponse,
			// Embeds an `execute` sub-query, so it can also surface QueryEngineValidationError.
			error: validatedQueryEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceDependenciesBundle", "/service-dependencies-bundle", {
			payload: ServiceDependenciesBundleRequest,
			success: ServiceDependenciesBundleResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceDbQuerySummary", "/service-db-query-summary", {
			payload: ServiceDbQuerySummaryRequest,
			success: ServiceDbQuerySummaryResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceExternalEdges", "/service-external-edges", {
			payload: ServiceExternalEdgesRequest,
			success: ServiceExternalEdgesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("servicePlatforms", "/service-platforms", {
			payload: ServicePlatformsRequest,
			success: ServicePlatformsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceWorkloads", "/service-workloads", {
			payload: ServiceWorkloadsRequest,
			success: ServiceWorkloadsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceUsage", "/service-usage", {
			payload: ServiceUsageRequest,
			success: ServiceUsageResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("listLogs", "/list-logs", {
			payload: ListLogsRequest,
			success: ListLogsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("getLog", "/get-log", {
			payload: GetLogRequest,
			success: GetLogResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("listMetrics", "/list-metrics", {
			payload: ListMetricsRequest,
			success: ListMetricsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("metricsSummary", "/metrics-summary", {
			payload: MetricsSummaryRequest,
			success: MetricsSummaryResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("executeQueryBuilder", "/execute-query-builder", {
			payload: ExecuteQueryBuilderRequest,
			success: ExecuteQueryBuilderResponse,
			error: validatedQueryEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("listHosts", "/list-hosts", {
			payload: ListHostsRequest,
			success: ListHostsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("hostDetailSummary", "/host-detail-summary", {
			payload: HostDetailSummaryRequest,
			success: HostDetailSummaryResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("hostInfraTimeseries", "/host-infra-timeseries", {
			payload: HostInfraTimeseriesRequest,
			success: HostInfraTimeseriesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("fleetUtilizationTimeseries", "/fleet-utilization-timeseries", {
			payload: FleetUtilizationTimeseriesRequest,
			success: FleetUtilizationTimeseriesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("listPods", "/list-pods", {
			payload: ListPodsRequest,
			success: ListPodsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("podDetailSummary", "/pod-detail-summary", {
			payload: PodDetailSummaryRequest,
			success: PodDetailSummaryResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("podInfraTimeseries", "/pod-infra-timeseries", {
			payload: PodInfraTimeseriesRequest,
			success: PodInfraTimeseriesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("listNodes", "/list-nodes", {
			payload: ListNodesRequest,
			success: ListNodesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("nodeDetailSummary", "/node-detail-summary", {
			payload: NodeDetailSummaryRequest,
			success: NodeDetailSummaryResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("nodeInfraTimeseries", "/node-infra-timeseries", {
			payload: NodeInfraTimeseriesRequest,
			success: NodeInfraTimeseriesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("listWorkloads", "/list-workloads", {
			payload: ListWorkloadsRequest,
			success: ListWorkloadsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("workloadDetailSummary", "/workload-detail-summary", {
			payload: WorkloadDetailSummaryRequest,
			success: WorkloadDetailSummaryResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("workloadInfraTimeseries", "/workload-infra-timeseries", {
			payload: WorkloadInfraTimeseriesRequest,
			success: WorkloadInfraTimeseriesResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("podFacets", "/pod-facets", {
			payload: PodFacetsRequest,
			success: PodFacetsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("nodeFacets", "/node-facets", {
			payload: NodeFacetsRequest,
			success: NodeFacetsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("workloadFacets", "/workload-facets", {
			payload: WorkloadFacetsRequest,
			success: WorkloadFacetsResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("executeRawSql", "/execute-raw-sql", {
			payload: RawSqlExecuteRequest,
			success: RawSqlExecuteResponse,
			error: [
				RawSqlValidationError,
				QueryEngineExecutionError,
				QueryEngineTimeoutError,
				...warehouseHttpErrors,
			] as const,
		}),
	)
	.prefix("/api/query-engine")
	.middleware(Authorization) {}
