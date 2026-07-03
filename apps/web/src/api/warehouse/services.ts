import { Clock, Effect, Schema } from "effect"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import {
	CommitSha,
	DeploymentEnvironment,
	ServiceApdexRequest,
	ServiceName,
	ServiceNamespace,
	ServiceHealthBaselineRequest,
	ServiceOverviewRequest,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import {
	buildBucketTimeline,
	computeBucketSeconds,
	toIsoBucket,
	trimSparseLeadingBuckets,
} from "@/api/warehouse/timeseries-utils"
import { summarizeSampling } from "@/lib/sampling"
import { resolveThroughput } from "@/api/warehouse/custom-charts"
import {
	WarehouseDateTimeString,
	decodeInput,
	executeQueryEngine,
	extractFacets,
	runWarehouseQuery,
} from "@/api/warehouse/effect-utils"

// Date format: "YYYY-MM-DD HH:mm:ss" (Tinybird/ClickHouse compatible)
const dateTimeString = WarehouseDateTimeString

// Service overview types
export interface CommitBreakdown {
	commitSha: string
	spanCount: number
	percentage: number
}

export interface ServiceOverview {
	serviceName: string
	serviceNamespace: string
	environment: string
	commits: CommitBreakdown[]
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	errorRate: number
	throughput: number
	tracedThroughput: number
	hasSampling: boolean
	samplingWeight: number
	spanCount: number
}

const GetServiceOverviewInput = Schema.Struct({
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
	environments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
	namespaces: Schema.optional(Schema.mutable(Schema.Array(ServiceNamespace))),
	commitShas: Schema.optional(Schema.mutable(Schema.Array(CommitSha))),
})

export type GetServiceOverviewInput = (typeof GetServiceOverviewInput)["Encoded"]

interface CoercedRow {
	serviceName: string
	serviceNamespace: string
	environment: string
	commitSha: string
	spanCount: number
	errorCount: number
	totalCount: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	estimatedSpanCount: number
}

function coerceRow(raw: Record<string, unknown>): CoercedRow {
	return {
		serviceName: String(raw.serviceName ?? ""),
		serviceNamespace: String(raw.serviceNamespace ?? ""),
		environment: String(raw.environment ?? "unknown"),
		commitSha: String(raw.commitSha ?? "N/A"),
		spanCount: Number(raw.spanCount ?? 0),
		errorCount: Number(raw.errorCount ?? 0),
		totalCount: Number(raw.throughput ?? 0),
		p50LatencyMs: Number(raw.p50LatencyMs ?? 0),
		p95LatencyMs: Number(raw.p95LatencyMs ?? 0),
		p99LatencyMs: Number(raw.p99LatencyMs ?? 0),
		estimatedSpanCount: Number(raw.estimatedSpanCount ?? 0),
	}
}

function aggregateByServiceEnvironment(rows: CoercedRow[], durationSeconds: number): ServiceOverview[] {
	const groups = new Map<string, CoercedRow[]>()

	for (const row of rows) {
		const key = `${row.serviceName}::${row.serviceNamespace}::${row.environment}`
		const group = groups.get(key)
		if (group) {
			group.push(row)
		} else {
			groups.set(key, [row])
		}
	}

	const results: ServiceOverview[] = []

	for (const group of groups.values()) {
		const totalSpans = group.reduce((sum, r) => sum + r.spanCount, 0)
		const totalErrors = group.reduce((sum, r) => sum + r.errorCount, 0)
		const totalEstimated = group.reduce((sum, r) => sum + r.estimatedSpanCount, 0)

		// Resolve throughput as sum(SampleRate) (pre-sampling estimate) → raw traced
		// count. Each row is environment-specific, and the per-env detail page it
		// links to resolves throughput the same way, so both agree. We deliberately
		// do NOT use the SpanMetrics `calls` counter here: it's a service-level,
		// ALL-environment value (it can't be filtered by `DeploymentEnv`), so on a
		// per-environment row it would attribute the entire service's volume to each
		// env (e.g. a tiny staging row inheriting the huge production count) and
		// disagree with the env-scoped detail charts.
		const resolvedCount = resolveThroughput(totalSpans, totalEstimated, undefined)
		const sampling = summarizeSampling(resolvedCount, totalSpans, durationSeconds)

		// Weighted average of latencies by span count
		let p50 = 0
		let p95 = 0
		let p99 = 0
		if (totalSpans > 0) {
			for (const r of group) {
				const weight = r.spanCount / totalSpans
				p50 += r.p50LatencyMs * weight
				p95 += r.p95LatencyMs * weight
				p99 += r.p99LatencyMs * weight
			}
		}

		const commits: CommitBreakdown[] = group
			.map((r) => ({
				commitSha: r.commitSha,
				spanCount: r.spanCount,
				percentage: totalSpans > 0 ? Math.round((r.spanCount / totalSpans) * 100) : 0,
			}))
			.sort((a, b) => b.percentage - a.percentage)

		results.push({
			serviceName: group[0].serviceName,
			serviceNamespace: group[0].serviceNamespace,
			environment: group[0].environment,
			commits,
			p50LatencyMs: p50,
			p95LatencyMs: p95,
			p99LatencyMs: p99,
			errorRate: totalSpans > 0 ? totalErrors / totalSpans : 0,
			throughput: sampling.hasSampling ? sampling.estimated : sampling.traced,
			tracedThroughput: sampling.traced,
			hasSampling: sampling.hasSampling,
			samplingWeight: sampling.weight,
			spanCount: totalSpans,
		})
	}

	// Sort by throughput descending (same as SQL ORDER BY)
	results.sort((a, b) => b.throughput - a.throughput)
	return results
}

export function getServiceOverview({ data }: { data: GetServiceOverviewInput }) {
	return getServiceOverviewEffect({ data })
}

const getServiceOverviewEffect = Effect.fn("QueryEngine.getServiceOverview")(function* ({
	data,
}: {
	data: GetServiceOverviewInput
}) {
	const input = yield* decodeInput(GetServiceOverviewInput, data ?? {}, "getServiceOverview")
	const fallback = defaultServicesTimeRange(yield* Clock.currentTimeMillis)

	const startTime = input.startTime ?? fallback.startTime
	const endTime = input.endTime ?? fallback.endTime

	// Throughput resolves from the env-scoped sum(SampleRate) estimate (see
	// `aggregateByServiceEnvironment`). The SpanMetrics `calls` counter is
	// deliberately NOT consulted here: it's service-level and all-environment (it
	// can't be filtered by `DeploymentEnv`), so on these per-environment rows it
	// would over-report and disagree with the env-scoped detail page.
	const result = yield* runWarehouseQuery("serviceOverview", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceOverview({
				payload: new ServiceOverviewRequest({
					startTime,
					endTime,
					environments: input.environments,
					namespaces: input.namespaces,
					commitShas: input.commitShas,
				}),
			})
		}),
	)

	const startMs = input.startTime ? new Date(input.startTime.replace(" ", "T") + "Z").getTime() : 0
	const endMs = input.endTime ? new Date(input.endTime.replace(" ", "T") + "Z").getTime() : 0
	const durationSeconds = startMs > 0 && endMs > 0 ? Math.max((endMs - startMs) / 1000, 1) : 3600

	const coercedRows = result.data.map(coerceRow)
	return {
		data: aggregateByServiceEnvironment(coercedRows, durationSeconds),
	}
})

// ---------------------------------------------------------------------------
// Service latency baseline (baseline-relative health)
// ---------------------------------------------------------------------------

export interface ServiceLatencyBaseline {
	serviceName: string
	serviceNamespace: string
	environment: string
	baselineP95LatencyMs: number
	baselineSpanCount: number
}

export interface ServiceHealthBaselineResult {
	data: ServiceLatencyBaseline[]
}

const GetServiceHealthBaselineInput = Schema.Struct({
	// Start of the range being judged; the baseline window is the trailing 7
	// days BEFORE this point so an ongoing regression can't inflate its own
	// baseline. Optional — defaults to "now".
	rangeStartTime: Schema.optional(dateTimeString),
	environments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
	namespaces: Schema.optional(Schema.mutable(Schema.Array(ServiceNamespace))),
})

export type GetServiceHealthBaselineInput = (typeof GetServiceHealthBaselineInput)["Encoded"]

const BASELINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

// Snap a "YYYY-MM-DD HH:mm:ss" datetime down to the hour so the request
// payload — and therefore the API-side cache key and the web atom key — stays
// stable for up to an hour regardless of small range changes.
const floorToHour = (dateTime: string) => `${dateTime.slice(0, 13)}:00:00`

const warehouseDateTimeToMs = (dateTime: string) => new Date(`${dateTime.replace(" ", "T")}Z`).getTime()

const msToWarehouseDateTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)

export function getServiceHealthBaseline({ data }: { data: GetServiceHealthBaselineInput }) {
	return getServiceHealthBaselineEffect({ data })
}

const getServiceHealthBaselineEffect = Effect.fn("QueryEngine.getServiceHealthBaseline")(function* ({
	data,
}: {
	data: GetServiceHealthBaselineInput
}) {
	const input = yield* decodeInput(GetServiceHealthBaselineInput, data ?? {}, "getServiceHealthBaseline")
	const nowDateTime = msToWarehouseDateTime(yield* Clock.currentTimeMillis)

	const endTime = floorToHour(input.rangeStartTime ?? nowDateTime)
	const startTime = msToWarehouseDateTime(warehouseDateTimeToMs(endTime) - BASELINE_WINDOW_MS)

	const response = yield* runWarehouseQuery("serviceHealthBaseline", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceHealthBaseline({
				payload: new ServiceHealthBaselineRequest({
					startTime,
					endTime,
					environments: input.environments,
					namespaces: input.namespaces,
				}),
			})
		}),
	)

	const result: ServiceHealthBaselineResult = {
		data: response.data.map((row) => ({
			serviceName: String(row.serviceName),
			serviceNamespace: row.serviceNamespace,
			environment: row.environment,
			baselineP95LatencyMs: row.baselineP95LatencyMs,
			baselineSpanCount: row.baselineSpanCount,
		})),
	}
	return result
})

// Service overview time series types
export interface ServiceTimeSeriesPoint {
	bucket: string
	throughput: number
	tracedThroughput: number
	hasSampling: boolean
	errorRate: number
}

function sortByBucket<T extends { bucket: string }>(rows: T[]): T[] {
	return rows.toSorted((left, right) => left.bucket.localeCompare(right.bucket))
}

function fillServiceApdexPoints(
	points: ServiceApdexTimeSeriesPoint[],
	startTime: string | undefined,
	endTime: string | undefined,
	bucketSeconds: number,
): ServiceApdexTimeSeriesPoint[] {
	const timeline = buildBucketTimeline(startTime, endTime, bucketSeconds)
	if (timeline.length === 0) {
		return sortByBucket(points)
	}

	const byBucket = new Map<string, ServiceApdexTimeSeriesPoint>()
	for (const point of points) {
		byBucket.set(toIsoBucket(point.bucket), point)
	}

	const filled = timeline.map((bucket) => {
		const existing = byBucket.get(bucket)
		if (existing) {
			return existing
		}

		return {
			bucket,
			apdexScore: 0,
			totalCount: 0,
		}
	})

	// Same leading-ramp guard as `fillServiceDetailPoints` — apdex is computed
	// against the bucket's `totalCount`, so a sparse first bucket would plot a
	// noisy apdex value against a backdrop of well-populated neighbors.
	return trimSparseLeadingBuckets(filled, (row) => row.totalCount ?? 0)
}

// Service facets types
interface FacetItem {
	name: string
	count: number
}

interface ServicesFacets {
	environments: FacetItem[]
	namespaces: FacetItem[]
	commitShas: FacetItem[]
	services: FacetItem[]
}

export interface ServicesFacetsResponse {
	data: ServicesFacets
}

const GetServicesFacetsInput = Schema.Struct({
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
})

export type GetServicesFacetsInput = Schema.Schema.Type<typeof GetServicesFacetsInput>

const defaultServicesTimeRange = (nowMillis: number) => {
	const fmt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(nowMillis - 24 * 60 * 60 * 1000), endTime: fmt(nowMillis) }
}

export function getServicesFacets({ data }: { data: GetServicesFacetsInput }) {
	return getServicesFacetsEffect({ data })
}

const getServicesFacetsEffect = Effect.fn("QueryEngine.getServicesFacets")(function* ({
	data,
}: {
	data: GetServicesFacetsInput
}) {
	const input = yield* decodeInput(GetServicesFacetsInput, data ?? {}, "getServicesFacets")
	const fallback = defaultServicesTimeRange(yield* Clock.currentTimeMillis)

	const response = yield* executeQueryEngine(
		"queryEngine.getServicesFacets",
		new QueryEngineExecuteRequest({
			startTime: input.startTime ?? fallback.startTime,
			endTime: input.endTime ?? fallback.endTime,
			query: { kind: "facets" as const, source: "services" as const },
		}),
	)

	const facetsData = extractFacets(response)
	const environments: FacetItem[] = []
	const namespaces: FacetItem[] = []
	const commitShas: FacetItem[] = []
	const services: FacetItem[] = []

	for (const row of facetsData) {
		const item = { name: row.name, count: Number(row.count) }
		switch (row.facetType) {
			case "environment":
				environments.push(item)
				break
			case "namespace":
				namespaces.push(item)
				break
			case "commitSha":
			case "commit_sha":
				commitShas.push(item)
				break
			case "service":
				services.push(item)
				break
		}
	}

	return {
		data: { environments, namespaces, commitShas, services },
	}
})

// Service detail types
export interface ServiceDetailTimeSeriesPoint {
	bucket: string
	throughput: number
	tracedThroughput: number
	hasSampling: boolean
	samplingWeight: number
	errorRate: number
	p50LatencyMs: number
	p95LatencyMs: number
	p99LatencyMs: number
	apdexScore: number
	totalCount: number
	/**
	 * The bucket is still settling — its window ends within the ingestion-lag
	 * budget of "now", so it's under-filled. Charts render flagged buckets as the
	 * dashed "in progress" segment instead of a solid crater.
	 */
	partial: boolean
}

interface ServiceApdexTimeSeriesPoint {
	bucket: string
	apdexScore: number
	totalCount: number
}

const GetServiceDetailInput = Schema.Struct({
	serviceName: ServiceName,
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
})

export type GetServiceDetailInput = (typeof GetServiceDetailInput)["Encoded"]

export function getServiceApdexTimeSeries({ data }: { data: GetServiceDetailInput }) {
	return getServiceApdexTimeSeriesEffect({ data })
}

const getServiceApdexTimeSeriesEffect = Effect.fn("QueryEngine.getServiceApdexTimeSeries")(function* ({
	data,
}: {
	data: GetServiceDetailInput
}) {
	const input = yield* decodeInput(GetServiceDetailInput, data, "getServiceApdexTimeSeries")
	const fallback = defaultServicesTimeRange(yield* Clock.currentTimeMillis)
	const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)

	const result = yield* runWarehouseQuery("serviceApdex", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceApdex({
				payload: new ServiceApdexRequest({
					serviceName: input.serviceName,
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					bucketSeconds,
				}),
			})
		}),
	)

	const points = result.data.map((row) => ({
		bucket: toIsoBucket(row.bucket),
		apdexScore: Number(row.apdexScore),
		totalCount: Number(row.totalCount),
	}))

	return {
		data: fillServiceApdexPoints(points, input.startTime, input.endTime, bucketSeconds),
	}
})
