import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { QueryEngineExecuteRequest, QueryEngineExecuteResponse, TinybirdDateTime } from "../query-engine"
import { Authorization } from "./current-tenant"
import { TinybirdQueryError, TinybirdQuotaExceededError } from "./tinybird"

// ---------------------------------------------------------------------------
// Dedicated endpoint schemas
// ---------------------------------------------------------------------------

export class SpanHierarchyRequest extends Schema.Class<SpanHierarchyRequest>("SpanHierarchyRequest")({
	traceId: Schema.String,
	spanId: Schema.optional(Schema.String),
}) {}

export class SpanHierarchyResponse extends Schema.Class<SpanHierarchyResponse>("SpanHierarchyResponse")({
	data: Schema.Array(
		Schema.Struct({
			traceId: Schema.String,
			spanId: Schema.String,
			parentSpanId: Schema.String,
			spanName: Schema.String,
			serviceName: Schema.String,
			spanKind: Schema.String,
			durationMs: Schema.Number,
			startTime: Schema.String,
			statusCode: Schema.String,
			statusMessage: Schema.String,
			spanAttributes: Schema.String,
			resourceAttributes: Schema.String,
		}),
	),
}) {}

const OptionalStringArray = Schema.optional(Schema.Array(Schema.String))

export class ErrorsByTypeRequest extends Schema.Class<ErrorsByTypeRequest>("ErrorsByTypeRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	rootOnly: Schema.optional(Schema.Boolean),
	services: OptionalStringArray,
	deploymentEnvs: OptionalStringArray,
	errorTypes: OptionalStringArray,
	limit: Schema.optional(Schema.Number),
}) {}

export class ErrorsByTypeResponse extends Schema.Class<ErrorsByTypeResponse>("ErrorsByTypeResponse")({
	data: Schema.Array(
		Schema.Struct({
			errorType: Schema.String,
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
		errorType: Schema.String,
		services: OptionalStringArray,
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
	services: OptionalStringArray,
	deploymentEnvs: OptionalStringArray,
	errorTypes: OptionalStringArray,
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
	errorType: Schema.String,
	rootOnly: Schema.optional(Schema.Boolean),
	services: OptionalStringArray,
	limit: Schema.optional(Schema.Number),
}) {}

export class ErrorDetailTracesResponse extends Schema.Class<ErrorDetailTracesResponse>(
	"ErrorDetailTracesResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			traceId: Schema.String,
			startTime: Schema.String,
			durationMicros: Schema.Number,
			spanCount: Schema.Number,
			services: Schema.Array(Schema.String),
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
			serviceName: Schema.String,
			totalLogs: Schema.Number,
			errorLogs: Schema.Number,
			errorRate: Schema.Number,
		}),
	),
}) {}

export class ServiceOverviewRequest extends Schema.Class<ServiceOverviewRequest>("ServiceOverviewRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	environments: OptionalStringArray,
	commitShas: OptionalStringArray,
}) {}

export class ServiceOverviewResponse extends Schema.Class<ServiceOverviewResponse>("ServiceOverviewResponse")(
	{
		data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
	},
) {}

export class ServiceApdexRequest extends Schema.Class<ServiceApdexRequest>("ServiceApdexRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	serviceName: Schema.String,
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

export class ServiceReleasesRequest extends Schema.Class<ServiceReleasesRequest>("ServiceReleasesRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	serviceName: Schema.String,
	bucketSeconds: Schema.optional(Schema.Number),
}) {}

export class ServiceReleasesResponse extends Schema.Class<ServiceReleasesResponse>("ServiceReleasesResponse")(
	{
		data: Schema.Array(
			Schema.Struct({
				bucket: Schema.String,
				commitSha: Schema.String,
				count: Schema.Number,
			}),
		),
	},
) {}

export class ServiceDependenciesRequest extends Schema.Class<ServiceDependenciesRequest>(
	"ServiceDependenciesRequest",
)({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	deploymentEnv: Schema.optional(Schema.String),
}) {}

export class ServiceDependenciesResponse extends Schema.Class<ServiceDependenciesResponse>(
	"ServiceDependenciesResponse",
)({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ServiceDbEdgesRequest extends Schema.Class<ServiceDbEdgesRequest>("ServiceDbEdgesRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	deploymentEnv: Schema.optional(Schema.String),
}) {}

export class ServiceDbEdgesResponse extends Schema.Class<ServiceDbEdgesResponse>("ServiceDbEdgesResponse")({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

const ServicePlatformLiteral = Schema.Literals(["kubernetes", "cloudflare", "lambda", "unknown"])

export class ServicePlatformsRequest extends Schema.Class<ServicePlatformsRequest>("ServicePlatformsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	deploymentEnv: Schema.optional(Schema.String),
}) {}

export class ServicePlatformsResponse extends Schema.Class<ServicePlatformsResponse>(
	"ServicePlatformsResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			serviceName: Schema.String,
			platform: ServicePlatformLiteral,
			k8sCluster: Schema.String,
			cloudPlatform: Schema.String,
			cloudProvider: Schema.String,
			faasName: Schema.String,
		}),
	),
}) {}

const ServiceWorkloadKindLiteral = Schema.Literals(["deployment", "statefulset", "daemonset", "unknown"])

export class ServiceWorkloadsRequest extends Schema.Class<ServiceWorkloadsRequest>("ServiceWorkloadsRequest")(
	{
		startTime: TinybirdDateTime,
		endTime: TinybirdDateTime,
		services: Schema.Array(Schema.String),
	},
) {}

export class ServiceWorkloadsResponse extends Schema.Class<ServiceWorkloadsResponse>(
	"ServiceWorkloadsResponse",
)({
	data: Schema.Array(
		Schema.Struct({
			serviceName: Schema.String,
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
	service: Schema.optional(Schema.String),
}) {}

export class ServiceUsageResponse extends Schema.Class<ServiceUsageResponse>("ServiceUsageResponse")({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ListLogsRequest extends Schema.Class<ListLogsRequest>("ListLogsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	service: Schema.optional(Schema.String),
	severity: Schema.optional(Schema.String),
	minSeverity: Schema.optional(Schema.Number),
	traceId: Schema.optional(Schema.String),
	spanId: Schema.optional(Schema.String),
	cursor: Schema.optional(Schema.String),
	search: Schema.optional(Schema.String),
	deploymentEnv: Schema.optional(Schema.String),
	deploymentEnvMatchMode: Schema.optional(Schema.Literal("contains")),
	limit: Schema.optional(Schema.Number),
}) {}

export class ListLogsResponse extends Schema.Class<ListLogsResponse>("ListLogsResponse")({
	data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export class ListMetricsRequest extends Schema.Class<ListMetricsRequest>("ListMetricsRequest")({
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
	service: Schema.optional(Schema.String),
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
	service: Schema.optional(Schema.String),
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

export const QueryBuilderQueryDraftSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	enabled: Schema.Boolean,
	dataSource: Schema.Literals(["traces", "logs", "metrics"]),
	signalSource: Schema.optional(Schema.Literals(["default", "meter"])),
	metricName: Schema.String,
	metricType: Schema.Literals(["sum", "gauge", "histogram", "exponential_histogram"]),
	isMonotonic: Schema.optional(Schema.Boolean),
	whereClause: Schema.String,
	aggregation: Schema.String,
	stepInterval: Schema.String,
	orderByDirection: Schema.optional(Schema.Literals(["desc", "asc"])),
	addOns: QueryBuilderAddOnsSchema,
	groupBy: Schema.mutable(Schema.Array(Schema.String)),
	having: Schema.optional(Schema.String),
	orderBy: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.String),
	legend: Schema.optional(Schema.String),
})
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
		pipe: Schema.optional(Schema.String),
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
// drives Effect's HttpApi to build a Schema union internally) and keeps script-
// startup CPU within Cloudflare Workers' 400ms validation budget (error 10021).
const queryEngineEndpointErrors = [
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
	TinybirdQueryError,
	TinybirdQuotaExceededError,
] as const

const validatedQueryEndpointErrors = [
	QueryEngineValidationError,
	QueryEngineExecutionError,
	QueryEngineTimeoutError,
	TinybirdQueryError,
	TinybirdQuotaExceededError,
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
		HttpApiEndpoint.post("serviceApdex", "/service-apdex", {
			payload: ServiceApdexRequest,
			success: ServiceApdexResponse,
			error: queryEngineEndpointErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("serviceReleases", "/service-releases", {
			payload: ServiceReleasesRequest,
			success: ServiceReleasesResponse,
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
		HttpApiEndpoint.post("serviceDbEdges", "/service-db-edges", {
			payload: ServiceDbEdgesRequest,
			success: ServiceDbEdgesResponse,
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
	.prefix("/api/query-engine")
	.middleware(Authorization) {}
