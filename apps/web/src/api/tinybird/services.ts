import { Effect, Schema } from "effect"
import { QueryEngineExecuteRequest } from "@maple/query-engine"
import { ServiceOverviewRequest, ServiceApdexRequest, ServiceReleasesRequest } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { buildBucketTimeline, computeBucketSeconds, toIsoBucket } from "@/api/tinybird/timeseries-utils"
import { summarizeSampling } from "@/lib/sampling"
import {
	TinybirdDateTimeString,
	decodeInput,
	executeQueryEngine,
	extractFacets,
	runTinybirdQuery,
} from "@/api/tinybird/effect-utils"

// Date format: "YYYY-MM-DD HH:mm:ss" (Tinybird/ClickHouse compatible)
const dateTimeString = TinybirdDateTimeString

// Service overview types
export interface CommitBreakdown {
	commitSha: string
	spanCount: number
	percentage: number
}

export interface ServiceOverview {
	serviceName: string
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
}

export interface ServiceOverviewResponse {
	data: ServiceOverview[]
}

const GetServiceOverviewInput = Schema.Struct({
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
	environments: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
	commitShas: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

export type GetServiceOverviewInput = Schema.Schema.Type<typeof GetServiceOverviewInput>

interface CoercedRow {
	serviceName: string
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
		const key = `${row.serviceName}::${row.environment}`
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

		const sampling = summarizeSampling(totalEstimated, totalSpans, durationSeconds)

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
	const fallback = defaultServicesTimeRange()

	const result = yield* runTinybirdQuery("serviceOverview", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceOverview({
				payload: new ServiceOverviewRequest({
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					environments: input.environments,
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

// Service overview time series types
export interface ServiceTimeSeriesPoint {
	bucket: string
	throughput: number
	tracedThroughput: number
	hasSampling: boolean
	errorRate: number
}

export interface ServiceOverviewTimeSeriesResponse {
	data: Record<string, ServiceTimeSeriesPoint[]>
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

	return timeline.map((bucket) => {
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
}

// Service facets types
export interface FacetItem {
	name: string
	count: number
}

export interface ServicesFacets {
	environments: FacetItem[]
	commitShas: FacetItem[]
}

export interface ServicesFacetsResponse {
	data: ServicesFacets
}

const GetServicesFacetsInput = Schema.Struct({
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
})

export type GetServicesFacetsInput = Schema.Schema.Type<typeof GetServicesFacetsInput>

const defaultServicesTimeRange = () => {
	const now = new Date()
	const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
	const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(dayAgo), endTime: fmt(now) }
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
	const fallback = defaultServicesTimeRange()

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
	const commitShas: FacetItem[] = []

	for (const row of facetsData) {
		const item = { name: row.name, count: Number(row.count) }
		switch (row.facetType) {
			case "environment":
				environments.push(item)
				break
			case "commitSha":
			case "commit_sha":
				commitShas.push(item)
				break
		}
	}

	return {
		data: { environments, commitShas },
	}
})

// Service releases timeline
export interface ServiceReleasesTimelinePoint {
	bucket: string
	commitSha: string
	count: number
}

export interface ServiceReleasesTimelineResponse {
	data: ServiceReleasesTimelinePoint[]
}

export function getServiceReleasesTimeline({ data }: { data: GetServiceDetailInput }) {
	return getServiceReleasesTimelineEffect({ data })
}

const getServiceReleasesTimelineEffect = Effect.fn("QueryEngine.getServiceReleasesTimeline")(function* ({
	data,
}: {
	data: GetServiceDetailInput
}) {
	const input = yield* decodeInput(GetServiceDetailInput, data, "getServiceReleasesTimeline")
	const fallback = defaultServicesTimeRange()
	const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)

	const result = yield* runTinybirdQuery("serviceReleases", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.queryEngine.serviceReleases({
				payload: new ServiceReleasesRequest({
					serviceName: input.serviceName,
					startTime: input.startTime ?? fallback.startTime,
					endTime: input.endTime ?? fallback.endTime,
					bucketSeconds,
				}),
			})
		}),
	)

	return {
		data: result.data.map((row) => ({
			bucket: toIsoBucket(row.bucket),
			commitSha: row.commitSha,
			count: Number(row.count),
		})),
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
}

export interface ServiceDetailTimeSeriesResponse {
	data: ServiceDetailTimeSeriesPoint[]
}

export interface ServiceApdexTimeSeriesPoint {
	bucket: string
	apdexScore: number
	totalCount: number
}

export interface ServiceApdexTimeSeriesResponse {
	data: ServiceApdexTimeSeriesPoint[]
}

const GetServiceDetailInput = Schema.Struct({
	serviceName: Schema.String,
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
})

export type GetServiceDetailInput = Schema.Schema.Type<typeof GetServiceDetailInput>

export function getServiceApdexTimeSeries({ data }: { data: GetServiceDetailInput }) {
	return getServiceApdexTimeSeriesEffect({ data })
}

const getServiceApdexTimeSeriesEffect = Effect.fn("QueryEngine.getServiceApdexTimeSeries")(function* ({
	data,
}: {
	data: GetServiceDetailInput
}) {
	const input = yield* decodeInput(GetServiceDetailInput, data, "getServiceApdexTimeSeries")
	const fallback = defaultServicesTimeRange()
	const bucketSeconds = computeBucketSeconds(input.startTime, input.endTime)

	const result = yield* runTinybirdQuery("serviceApdex", () =>
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
