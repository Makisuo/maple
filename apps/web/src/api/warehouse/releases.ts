import { Clock, Effect, Schema } from "effect"
import { formatWarehouseDateTime } from "@maple/query-engine"
import {
	CommitSha,
	DeploymentEnvironment,
	ReleaseDetailRequest,
	ReleasesListRequest,
	ServiceName,
	ServiceNamespace,
	type ReleaseRow,
	type ReleaseTimelinePoint,
} from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import {
	buildServiceDetailPoints,
	makeAllMetricsTimeseriesRequest,
	toEnvFilter,
} from "@/api/warehouse/custom-charts"
import type { ServiceDetailTimeSeriesPoint } from "@/api/warehouse/services"
import { computeBucketSeconds, quantizeToMinute, toIsoBucket } from "@/api/warehouse/timeseries-utils"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

const dateTimeString = WarehouseDateTimeString

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Swimlane resolution: about this many buckets across the window. */
const TIMELINE_TARGET_POINTS = 96

const defaultWindow = (nowMs: number) => ({
	startTime: formatWarehouseDateTime(nowMs - DEFAULT_WINDOW_MS),
	endTime: formatWarehouseDateTime(nowMs),
})

/** A release row with its warehouse datetimes normalised to ISO. */
export interface Release extends Omit<ReleaseRow, "firstSeen" | "lastSeen"> {
	firstSeen: string
	lastSeen: string
}

export interface ReleaseTimelineBucket extends Omit<ReleaseTimelinePoint, "bucket"> {
	bucket: string
}

const toRelease = (row: ReleaseRow): Release => ({
	...row,
	firstSeen: toIsoBucket(row.firstSeen),
	lastSeen: toIsoBucket(row.lastSeen),
})

const toTimelineBucket = (row: ReleaseTimelinePoint): ReleaseTimelineBucket => ({
	...row,
	bucket: toIsoBucket(row.bucket),
})

// Releases list

const GetReleasesInput = Schema.Struct({
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
	environments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
	namespaces: Schema.optional(Schema.mutable(Schema.Array(ServiceNamespace))),
	services: Schema.optional(Schema.mutable(Schema.Array(ServiceName))),
	excludedEnvironments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
	excludedNamespaces: Schema.optional(Schema.mutable(Schema.Array(ServiceNamespace))),
})

export type GetReleasesInput = (typeof GetReleasesInput)["Encoded"]

export interface ReleasesResult {
	releases: Release[]
	timeline: ReleaseTimelineBucket[]
	truncated: boolean
	/** The window the rows describe, ISO — the page derives "share of the last bucket" against it. */
	startTime: string
	endTime: string
	bucketSeconds: number
}

export function getReleases({ data }: { data: GetReleasesInput }) {
	return getReleasesEffect({ data })
}

const getReleasesEffect = Effect.fn("QueryEngine.getReleases")(function* ({
	data,
}: {
	data: GetReleasesInput
}) {
	const input = yield* decodeInput(GetReleasesInput, data ?? {}, "getReleases")
	const fallback = defaultWindow(yield* Clock.currentTimeMillis)
	const startTime = input.startTime ?? fallback.startTime
	const endTime = input.endTime ?? fallback.endTime
	// Whole minutes: the rollup tiers cannot place a row inside a minute, and
	// the raw fallback would scan the entry-point projection org-wide.
	const bucketSeconds = Math.max(
		60,
		quantizeToMinute(computeBucketSeconds(startTime, endTime, TIMELINE_TARGET_POINTS)),
	)

	const result = yield* runWarehouseQuery("releasesList", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.releasesList({
				payload: new ReleasesListRequest({
					startTime,
					endTime,
					environments: toEnvFilter(input.environments),
					namespaces: input.namespaces,
					services: input.services,
					excludedEnvironments: toEnvFilter(input.excludedEnvironments),
					excludedNamespaces: input.excludedNamespaces,
					bucketSeconds,
				}),
			})
		}),
	)

	return {
		releases: result.releases.map(toRelease),
		timeline: result.timeline.map(toTimelineBucket),
		truncated: result.truncated,
		startTime: toIsoBucket(startTime),
		endTime: toIsoBucket(endTime),
		bucketSeconds,
	} satisfies ReleasesResult
})

// Release detail

const GetReleaseDetailInput = Schema.Struct({
	serviceName: ServiceName,
	commitSha: CommitSha,
	startTime: Schema.optional(dateTimeString),
	endTime: Schema.optional(dateTimeString),
	environments: Schema.optional(Schema.mutable(Schema.Array(DeploymentEnvironment))),
})

export type GetReleaseDetailInput = (typeof GetReleaseDetailInput)["Encoded"]

export interface ReleaseErrorFingerprint {
	fingerprintHash: string
	count: number
	firstSeen: string
	lastSeen: string
}

export interface ReleaseDetailResult {
	/** Every version of the service in the window, this one included. */
	versions: Release[]
	timeline: ReleaseTimelineBucket[]
	/** Golden signals for this version only. */
	points: ServiceDetailTimeSeriesPoint[]
	/** Golden signals for every other version of the service. */
	baselinePoints: ServiceDetailTimeSeriesPoint[]
	errorFingerprints: ReleaseErrorFingerprint[]
	startTime: string
	endTime: string
	bucketSeconds: number
}

export function getReleaseDetail({ data }: { data: GetReleaseDetailInput }) {
	return getReleaseDetailEffect({ data })
}

const getReleaseDetailEffect = Effect.fn("QueryEngine.getReleaseDetail")(function* ({
	data,
}: {
	data: GetReleaseDetailInput
}) {
	const input = yield* decodeInput(GetReleaseDetailInput, data, "getReleaseDetail")
	const nowMs = yield* Clock.currentTimeMillis
	const fallback = defaultWindow(nowMs)
	const startTime = input.startTime ?? fallback.startTime
	const endTime = input.endTime ?? fallback.endTime
	const bucketSeconds = Math.max(60, quantizeToMinute(computeBucketSeconds(startTime, endTime)))
	const environments = toEnvFilter(input.environments)

	const common = {
		startTime,
		endTime,
		bucketSeconds,
		serviceName: input.serviceName,
		rootSpansOnly: true,
		environments,
	}

	const result = yield* runWarehouseQuery("releaseDetail", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.releaseDetail({
				payload: new ReleaseDetailRequest({
					serviceName: input.serviceName,
					commitSha: input.commitSha,
					startTime,
					endTime,
					environments,
					timeseries: makeAllMetricsTimeseriesRequest({ ...common, commitShas: [input.commitSha] }),
					baselineTimeseries: makeAllMetricsTimeseriesRequest({
						...common,
						excludedCommitShas: [input.commitSha],
					}),
					bucketSeconds,
				}),
			})
		}),
	)

	return {
		versions: result.versions.map(toRelease),
		timeline: result.timeline.map(toTimelineBucket),
		points: buildServiceDetailPoints(result.timeseries, startTime, endTime, bucketSeconds, nowMs),
		baselinePoints: buildServiceDetailPoints(
			result.baselineTimeseries,
			startTime,
			endTime,
			bucketSeconds,
			nowMs,
		),
		errorFingerprints: result.errorFingerprints.map((row) => ({
			fingerprintHash: row.fingerprintHash,
			count: row.count,
			firstSeen: toIsoBucket(row.firstSeen),
			lastSeen: toIsoBucket(row.lastSeen),
		})),
		startTime: toIsoBucket(startTime),
		endTime: toIsoBucket(endTime),
		bucketSeconds,
	} satisfies ReleaseDetailResult
})
