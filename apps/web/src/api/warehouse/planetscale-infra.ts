import { Clock, Effect, Schema } from "effect"
import {
	PlanetScaleEventsRequest,
	PlanetScaleInfraTimeseriesRequest,
	PlanetScaleQueryInsightsRequest,
} from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

import { formatWarehouseDateTime } from "@maple/query-engine"
/**
 * /infra/planetscale data access. The fleet view composes the polled inventory
 * (integrations `planetscaleDatabases`) with the service-map stat rollups; the
 * per-database detail charts read this bucketed timeseries.
 */

export interface PlanetScaleInfraTimeseriesRow {
	bucket: string
	connectionsAvg: number
	cpuMaxPercent: number
	memMaxPercent: number
	replicaLagMaxSeconds: number
	/** Disk used (0–100), or null when the volume gauges didn't report this bucket. */
	storageUsedPercent: number | null
}

const GetPlanetScaleInfraTimeseriesInputSchema = Schema.Struct({
	database: Schema.String,
	/** Omit for database-wide (every branch); set to narrow to one branch. */
	branch: Schema.optional(Schema.String),
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	bucketSeconds: Schema.Number,
})

export type GetPlanetScaleInfraTimeseriesInput = (typeof GetPlanetScaleInfraTimeseriesInputSchema)["Encoded"]

const defaultTimeRange = (nowMillis: number) => {
	return {
		startTime: formatWarehouseDateTime(nowMillis - 24 * 60 * 60 * 1000),
		endTime: formatWarehouseDateTime(nowMillis),
	}
}

export interface PlanetScaleQueryInsightEntry {
	fingerprint: string
	normalizedSql: string
	statementType: string | null
	queryCount: number
	errorCount: number
	errorRate: number
	totalDurationMillis: number
	timePerQueryMillis: number
	p50LatencyMillis: number
	p99LatencyMillis: number
	rowsReadPerQuery: number
	lastRunAt: number | null
}

const GetPlanetScaleQueryInsightsInputSchema = Schema.Struct({
	database: Schema.String,
	branch: Schema.optional(Schema.String),
	/** Window bounds, epoch ms. */
	startTime: Schema.Number,
	endTime: Schema.Number,
	limit: Schema.optional(Schema.Number),
})

export type GetPlanetScaleQueryInsightsInput = (typeof GetPlanetScaleQueryInsightsInputSchema)["Encoded"]

/** Live PlanetScale Query Insights top queries (proxied, briefly edge-cached). */
export const getPlanetScaleQueryInsights = Effect.fn("Integrations.getPlanetScaleQueryInsights")(function* ({
	data,
}: {
	data: GetPlanetScaleQueryInsightsInput
}) {
	const input = yield* decodeInput(
		GetPlanetScaleQueryInsightsInputSchema,
		data,
		"getPlanetScaleQueryInsights",
	)
	const result = yield* runWarehouseQuery("planetscaleQueryInsights", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.integrations.planetscaleQueryInsights({
				payload: new PlanetScaleQueryInsightsRequest({
					database: input.database,
					...(input.branch === undefined ? {} : { branch: input.branch }),
					startTime: input.startTime,
					endTime: input.endTime,
					...(input.limit === undefined ? {} : { limit: input.limit }),
				}),
			})
		}),
	)
	return {
		branch: result.branch,
		unavailableReason: result.unavailableReason,
		rows: result.rows.map(
			(row): PlanetScaleQueryInsightEntry => ({
				fingerprint: row.fingerprint,
				normalizedSql: row.normalizedSql,
				statementType: row.statementType,
				queryCount: row.queryCount,
				errorCount: row.errorCount,
				errorRate: row.queryCount > 0 ? row.errorCount / row.queryCount : 0,
				totalDurationMillis: row.totalDurationMillis,
				timePerQueryMillis: row.timePerQueryMillis,
				p50LatencyMillis: row.p50LatencyMillis,
				p99LatencyMillis: row.p99LatencyMillis,
				rowsReadPerQuery: row.rowsReadPerQuery,
				lastRunAt: row.lastRunAt,
			}),
		),
	}
})

const GetPlanetScaleEventsInputSchema = Schema.Struct({
	/** Omit for the org-wide feed. */
	database: Schema.optional(Schema.String),
	branch: Schema.optional(Schema.String),
	/** Window bounds, epoch ms. */
	startTime: Schema.Number,
	endTime: Schema.Number,
	limit: Schema.optional(Schema.Number),
})

export type GetPlanetScaleEventsInput = (typeof GetPlanetScaleEventsInputSchema)["Encoded"]

/**
 * The PlanetScale lifecycle timeline for a window — deploy transitions, branch
 * state changes, health events. Backs the chart markers and the activity feed.
 */
export const getPlanetScaleEvents = Effect.fn("Integrations.getPlanetScaleEvents")(function* ({
	data,
}: {
	data: GetPlanetScaleEventsInput
}) {
	const input = yield* decodeInput(GetPlanetScaleEventsInputSchema, data, "getPlanetScaleEvents")
	const result = yield* runWarehouseQuery("planetscaleEvents", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiAtomClient
			return yield* client.integrations.planetscaleEvents({
				payload: new PlanetScaleEventsRequest({
					...(input.database === undefined ? {} : { database: input.database }),
					...(input.branch === undefined ? {} : { branch: input.branch }),
					startTime: input.startTime,
					endTime: input.endTime,
					...(input.limit === undefined ? {} : { limit: input.limit }),
				}),
			})
		}),
	)
	return { events: result.events, nextCursor: result.nextCursor }
})

export const getPlanetScaleInfraTimeseries = Effect.fn("QueryEngine.getPlanetScaleInfraTimeseries")(
	function* ({ data }: { data: GetPlanetScaleInfraTimeseriesInput }) {
		const input = yield* decodeInput(
			GetPlanetScaleInfraTimeseriesInputSchema,
			data,
			"getPlanetScaleInfraTimeseries",
		)
		const fallback = defaultTimeRange(yield* Clock.currentTimeMillis)

		const result = yield* runWarehouseQuery("planetscaleInfraTimeseries", () =>
			Effect.gen(function* () {
				const client = yield* MapleApiAtomClient
				return yield* client.queryEngine.planetscaleInfraTimeseries({
					payload: new PlanetScaleInfraTimeseriesRequest({
						startTime: input.startTime ?? fallback.startTime,
						endTime: input.endTime ?? fallback.endTime,
						bucketSeconds: input.bucketSeconds,
						database: input.database,
						...(input.branch === undefined ? {} : { branch: input.branch }),
					}),
				})
			}),
		)

		return {
			buckets: result.data.map((row): PlanetScaleInfraTimeseriesRow => {
				const samples = Number(row.storageSamples ?? 0)
				return {
					bucket: String(row.bucket ?? ""),
					connectionsAvg: Number(row.connectionsAvg ?? 0),
					cpuMaxPercent: Number(row.cpuMaxPercent ?? 0),
					memMaxPercent: Number(row.memMaxPercent ?? 0),
					replicaLagMaxSeconds: Number(row.replicaLagMaxSeconds ?? 0),
					// Buckets with no free-space sample get null, not 0% — a gap in the
					// series must read as a gap, never as an empty disk.
					storageUsedPercent: samples > 0 ? Number(row.storageUsedPercent ?? 0) : null,
				}
			}),
		}
	},
)
