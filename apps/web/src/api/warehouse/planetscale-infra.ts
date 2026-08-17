import { Clock, Effect, Schema } from "effect"
import { PlanetScaleInfraTimeseriesRequest } from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import {
	WarehouseDateTimeString,
	decodeInput,
	runWarehouseQuery,
	runWarehouseQueryV2,
} from "@/api/warehouse/effect-utils"

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

/** The v2 wire format is ISO-8601; every caller in here still speaks epoch ms. */
const toIso = (epochMs: number) => new Date(epochMs).toISOString()

/**
 * One lifecycle event, in the camelCase/epoch-ms shape the infra components
 * consume. Mapped here rather than passing the wire object through, so the
 * activity feed and chart markers stay insulated from the API's field casing.
 */
export interface PlanetScaleEventEntry {
	id: string
	databaseName: string
	branchName: string
	category: string
	eventType: string
	state: string | null
	externalId: string
	title: string
	source: string
	actorLogin: string | null
	url: string | null
	/** Epoch ms. */
	occurredAt: number
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
	const result = yield* runWarehouseQueryV2("planetscaleQueryInsights", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			return yield* client.planetscaleIntegration.queryInsights({
				payload: {
					database: input.database,
					...(!(input.branch === undefined) ? { branch: input.branch } : undefined),
					start_time: toIso(input.startTime),
					end_time: toIso(input.endTime),
					...(!(input.limit === undefined) ? { limit: input.limit } : undefined),
				},
			})
		}),
	)
	return {
		branch: result.branch,
		unavailableReason: result.unavailable_reason,
		rows: result.data.map(
			(row): PlanetScaleQueryInsightEntry => ({
				fingerprint: row.fingerprint,
				normalizedSql: row.normalized_sql,
				statementType: row.statement_type,
				queryCount: row.query_count,
				errorCount: row.error_count,
				errorRate: row.query_count > 0 ? row.error_count / row.query_count : 0,
				totalDurationMillis: row.total_duration_millis,
				timePerQueryMillis: row.time_per_query_millis,
				p50LatencyMillis: row.p50_latency_millis,
				p99LatencyMillis: row.p99_latency_millis,
				rowsReadPerQuery: row.rows_read_per_query,
				lastRunAt: row.last_run_at === null ? null : Date.parse(row.last_run_at),
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
	const result = yield* runWarehouseQueryV2("planetscaleEvents", () =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2AtomClient
			return yield* client.planetscaleIntegration.events({
				payload: {
					...(!(input.database === undefined) ? { database: input.database } : undefined),
					...(!(input.branch === undefined) ? { branch: input.branch } : undefined),
					start_time: toIso(input.startTime),
					end_time: toIso(input.endTime),
					...(!(input.limit === undefined) ? { limit: input.limit } : undefined),
				},
			})
		}),
	)
	return {
		events: result.data.map(
			(row): PlanetScaleEventEntry => ({
				id: row.id,
				databaseName: row.database_name,
				branchName: row.branch_name,
				category: row.category,
				eventType: row.event_type,
				state: row.state,
				externalId: row.external_id,
				title: row.title,
				source: row.source,
				actorLogin: row.actor_login,
				url: row.url,
				occurredAt: Date.parse(row.occurred_at),
			}),
		),
		nextCursor: result.next_cursor,
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
				const client = yield* MapleInternalAtomClient
				return yield* client.queryEngine.planetscaleInfraTimeseries({
					payload: new PlanetScaleInfraTimeseriesRequest({
						startTime: input.startTime ?? fallback.startTime,
						endTime: input.endTime ?? fallback.endTime,
						bucketSeconds: input.bucketSeconds,
						database: input.database,
						...(!(input.branch === undefined) ? { branch: input.branch } : undefined),
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
