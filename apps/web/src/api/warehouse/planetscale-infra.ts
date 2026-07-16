import { Clock, Effect, Schema } from "effect"
import { PlanetScaleInfraTimeseriesRequest, PlanetScaleQueryInsightsRequest } from "@maple/domain/http"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

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
}

const GetPlanetScaleInfraTimeseriesInputSchema = Schema.Struct({
	database: Schema.String,
	startTime: Schema.optional(WarehouseDateTimeString),
	endTime: Schema.optional(WarehouseDateTimeString),
	bucketSeconds: Schema.Number,
})

export type GetPlanetScaleInfraTimeseriesInput = (typeof GetPlanetScaleInfraTimeseriesInputSchema)["Encoded"]

const defaultTimeRange = (nowMillis: number) => {
	const fmt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
	return { startTime: fmt(nowMillis - 24 * 60 * 60 * 1000), endTime: fmt(nowMillis) }
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
					}),
				})
			}),
		)

		return {
			buckets: result.data.map(
				(row): PlanetScaleInfraTimeseriesRow => ({
					bucket: String(row.bucket ?? ""),
					connectionsAvg: Number(row.connectionsAvg ?? 0),
					cpuMaxPercent: Number(row.cpuMaxPercent ?? 0),
					memMaxPercent: Number(row.memMaxPercent ?? 0),
					replicaLagMaxSeconds: Number(row.replicaLagMaxSeconds ?? 0),
				}),
			),
		}
	},
)
