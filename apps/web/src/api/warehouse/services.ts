import { Clock, Effect, Schema } from "effect"
import {
	QueryEngineExecuteRequest,
	coerceServiceOverviewRows,
	formatWarehouseDateTime,
	parseWarehouseDateTime,
	windowDurationSeconds,
} from "@maple/query-engine"
import {
	CommitSha,
	DeploymentEnvironment,
	ServiceApdexRequest,
	ServiceName,
	ServiceNamespace,
	ServiceHealthBaselineRequest,
	ServiceHealthSnapshotRequest,
	ServiceOverviewRequest,
} from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import {
	buildBucketTimeline,
	computeBucketSeconds,
	toIsoBucket,
	trimSparseLeadingBuckets,
} from "@/api/warehouse/timeseries-utils"
import {
	WarehouseDateTimeString,
	decodeInput,
	executeQueryEngine,
	extractFacets,
	runWarehouseQuery,
} from "@/api/warehouse/effect-utils"

// Date format: "YYYY-MM-DD HH:mm:ss" (Tinybird/ClickHouse compatible)
const dateTimeString = WarehouseDateTimeString

// Service overview types and row shaping live in `@maple/query-engine`
// (`route-rows.ts`) so the share API's `service_overview` plan produces the same
// per-second, sampling-corrected rows this function does. Re-exported here for
// the existing imports.
export {
	type CommitBreakdown,
	type ServiceOverview,
	coerceServiceOverviewRows as coerceOverviewRows,
} from "@maple/query-engine"

const GetServiceOverviewInput = Schema.Struct({
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
	environments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
	namespaces: Schema.optional(Schema.mutable(Schema.Array(ServiceNamespace))),
	commitShas: Schema.optional(Schema.mutable(Schema.Array(CommitSha))),
	excludedEnvironments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
	excludedNamespaces: Schema.optional(Schema.mutable(Schema.Array(ServiceNamespace))),
	excludedCommitShas: Schema.optional(Schema.mutable(Schema.Array(CommitSha))),
})

export type GetServiceOverviewInput = (typeof GetServiceOverviewInput)["Encoded"]

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
	// `coerceServiceOverviewRow` in `@maple/query-engine`). The SpanMetrics
	// `calls` counter is deliberately NOT consulted
	// here: it's service-level and all-environment (it can't be filtered by
	// `DeploymentEnv`), so on these per-environment rows it would over-report and
	// disagree with the env-scoped detail page.
	const result = yield* runWarehouseQuery("serviceOverview", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.serviceOverview({
				payload: new ServiceOverviewRequest({
					startTime,
					endTime,
					environments: input.environments,
					namespaces: input.namespaces,
					commitShas: input.commitShas,
					excludedEnvironments: input.excludedEnvironments,
					excludedNamespaces: input.excludedNamespaces,
					excludedCommitShas: input.excludedCommitShas,
				}),
			})
		}),
	)

	return {
		data: coerceServiceOverviewRows(result.data, windowDurationSeconds(input.startTime, input.endTime)),
	}
})

// Fast service-health snapshot (main overview)

export interface ServiceHealthSnapshot {
	serviceName: string
	environment: string
	requestCount: number
	errorCount: number
	errorRate: number
	p95LatencyMs: number
	throughput: number
}

const GetServiceHealthSnapshotInput = Schema.Struct({
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
	environments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
})

export type GetServiceHealthSnapshotInput = (typeof GetServiceHealthSnapshotInput)["Encoded"]

export function getServiceHealthSnapshot({ data }: { data: GetServiceHealthSnapshotInput }) {
	return getServiceHealthSnapshotEffect({ data })
}

const getServiceHealthSnapshotEffect = Effect.fn("QueryEngine.getServiceHealthSnapshot")(function* ({
	data,
}: {
	data: GetServiceHealthSnapshotInput
}) {
	const input = yield* decodeInput(GetServiceHealthSnapshotInput, data ?? {}, "getServiceHealthSnapshot")
	const fallback = defaultServicesTimeRange(yield* Clock.currentTimeMillis)
	const startTime = input.startTime ?? fallback.startTime
	const endTime = input.endTime ?? fallback.endTime
	const durationSeconds = Math.max(
		(warehouseDateTimeToMs(endTime) - warehouseDateTimeToMs(startTime)) / 1000,
		1,
	)

	const response = yield* runWarehouseQuery("serviceHealthSnapshot", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.serviceHealthSnapshot({
				payload: new ServiceHealthSnapshotRequest({
					startTime,
					endTime,
					environments: input.environments,
				}),
			})
		}),
	)

	return {
		data: response.data.map(
			(row): ServiceHealthSnapshot => ({
				serviceName: String(row.serviceName),
				environment: row.environment || "unknown",
				requestCount: row.requestCount,
				errorCount: row.errorCount,
				errorRate: row.requestCount > 0 ? row.errorCount / row.requestCount : 0,
				p95LatencyMs: row.p95LatencyMs,
				throughput: row.requestCount / durationSeconds,
			}),
		),
	}
})

// Service latency baseline (baseline-relative health)

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

const warehouseDateTimeToMs = parseWarehouseDateTime

export function getServiceHealthBaseline({ data }: { data: GetServiceHealthBaselineInput }) {
	return getServiceHealthBaselineEffect({ data })
}

const getServiceHealthBaselineEffect = Effect.fn("QueryEngine.getServiceHealthBaseline")(function* ({
	data,
}: {
	data: GetServiceHealthBaselineInput
}) {
	const input = yield* decodeInput(GetServiceHealthBaselineInput, data ?? {}, "getServiceHealthBaseline")
	const nowDateTime = formatWarehouseDateTime(yield* Clock.currentTimeMillis)

	const endTime = floorToHour(input.rangeStartTime ?? nowDateTime)
	const startTime = formatWarehouseDateTime(warehouseDateTimeToMs(endTime) - BASELINE_WINDOW_MS)

	const response = yield* runWarehouseQuery("serviceHealthBaseline", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
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
	return {
		startTime: formatWarehouseDateTime(nowMillis - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(nowMillis),
	}
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
			const client = yield* MapleInternalAtomClient
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
