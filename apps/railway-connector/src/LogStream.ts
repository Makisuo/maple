/**
 * Per-target log streaming: one `environmentLogs` GraphQL subscription per
 * enabled (project, environment) target covers every service in the
 * environment. Entries buffer in memory and flush to the ingest gateway as
 * OTLP logs every few seconds; the connection reconnects with exponential
 * backoff and the delivered watermark rides result reports back to the api.
 */
import { Clock, Duration, Effect, Result } from "effect"
import { RailwayResultReport, type InternalRailwayTarget } from "@maple/domain/http"
import { buildLogsExportRequest, decodeRailwayLogEntry, type RailwayLogEntry } from "./otlp/logs"
import {
	ENVIRONMENT_LOGS_SUBSCRIPTION,
	runGraphqlWsSubscription,
	type WebSocketFactory,
} from "./RailwaySubscriptionClient"
import type { OtlpIngestShape } from "./OtlpIngest"

const FLUSH_INTERVAL = Duration.seconds(3)
/** Flush immediately once this many entries are buffered. */
export const FLUSH_BATCH_SIZE = 500
/** Bound the in-memory buffer during ingest outages; oldest entries drop first. */
export const MAX_BUFFERED_ENTRIES = 10_000
/** Reconnect backoff bounds. */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = Duration.toMillis(Duration.minutes(5))
/** A connection that survived this long resets the backoff counter. */
const STABLE_CONNECTION_MS = 60_000

export interface LogStreamState {
	buffer: RailwayLogEntry[]
	droppedSinceLastReport: number
	/** Epoch ms of the newest entry delivered to ingest. */
	watermarkMs: number | null
}

/**
 * Enqueue a decoded entry, dropping entries at/below the watermark (replay
 * overlap after a reconnect) and evicting the oldest on overflow.
 */
export const enqueueLogEntry = (state: LogStreamState, entry: RailwayLogEntry): void => {
	if (state.watermarkMs !== null && entry.timestampMs <= state.watermarkMs) return
	if (state.buffer.length >= MAX_BUFFERED_ENTRIES) {
		state.buffer.shift()
		state.droppedSinceLastReport += 1
	}
	state.buffer.push(entry)
}

export const reconnectDelayMs = (consecutiveFailures: number): number =>
	Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** consecutiveFailures)

export interface LogStreamDeps {
	readonly wsUrl: string
	readonly otlp: Pick<OtlpIngestShape, "sendLogs">
	readonly enqueueReport: (report: RailwayResultReport) => Effect.Effect<void>
	readonly webSocketFactory?: WebSocketFactory
}

/** Run one target's log stream forever (flush loop + reconnecting subscription). */
export const runLogStream = (
	target: InternalRailwayTarget,
	deps: LogStreamDeps,
): Effect.Effect<never> =>
	Effect.gen(function* () {
		const state: LogStreamState = {
			buffer: [],
			droppedSinceLastReport: 0,
			watermarkMs: target.logWatermarkMs,
		}

		const flushOnce = Effect.gen(function* () {
			if (state.buffer.length === 0) return
			const now = yield* Clock.currentTimeMillis
			const entries = state.buffer
			state.buffer = []
			const dropped = state.droppedSinceLastReport
			state.droppedSinceLastReport = 0

			const request = buildLogsExportRequest(entries, {
				projectId: target.projectId,
				projectName: target.projectName,
				environmentId: target.environmentId,
				environmentName: target.environmentName,
				services: target.services,
				observedAtMs: now,
			})
			if (request === null) return

			const outcome = yield* Effect.result(deps.otlp.sendLogs(target.ingestKey, request))
			if (Result.isSuccess(outcome)) {
				const maxTs = entries.reduce((max, entry) => Math.max(max, entry.timestampMs), 0)
				if (state.watermarkMs === null || maxTs > state.watermarkMs) state.watermarkMs = maxTs
				yield* deps.enqueueReport(
					new RailwayResultReport({
						targetId: target.id,
						kind: "logs",
						at: now,
						error: null,
						recordsIngested: entries.length,
						...(dropped > 0 ? { recordsDropped: dropped } : {}),
						...(state.watermarkMs !== null ? { newLogWatermarkMs: state.watermarkMs } : {}),
					}),
				)
				return
			}

			// Ingest failure: a billing-limit 402 drops the batch (retrying cannot
			// succeed until the limit resets); anything else re-buffers in front,
			// bounded by MAX_BUFFERED_ENTRIES with oldest-first eviction.
			const error = outcome.failure
			if (error.status === 402) {
				// `dropped` (pre-flush overflow evictions) was reset above — carry it
				// into the count alongside the batch this branch is discarding.
				state.droppedSinceLastReport += dropped + entries.length
			} else {
				const room = MAX_BUFFERED_ENTRIES - state.buffer.length
				const requeued = entries.slice(Math.max(0, entries.length - room))
				state.droppedSinceLastReport += dropped + (entries.length - requeued.length)
				state.buffer = [...requeued, ...state.buffer]
			}
			yield* deps.enqueueReport(
				new RailwayResultReport({
					targetId: target.id,
					kind: "logs",
					at: now,
					error: error.message,
					...(state.droppedSinceLastReport > 0
						? { recordsDropped: state.droppedSinceLastReport }
						: {}),
				}),
			)
			yield* Effect.logWarning("Railway log flush failed").pipe(
				Effect.annotateLogs({ targetId: target.id, orgId: target.orgId, error: error.message }),
			)
		})

		// Flush on a cadence and immediately once a batch fills up.
		yield* Effect.forkChild(
			Effect.gen(function* () {
				while (true) {
					yield* Effect.sleep(
						state.buffer.length >= FLUSH_BATCH_SIZE ? Duration.millis(50) : FLUSH_INTERVAL,
					)
					yield* flushOnce
				}
			}),
		)

		let consecutiveFailures = 0
		while (true) {
			const connectedAt = yield* Clock.currentTimeMillis
			const outcome = yield* Effect.result(
				runGraphqlWsSubscription({
				wsUrl: deps.wsUrl,
				token: target.token,
				query: ENVIRONMENT_LOGS_SUBSCRIPTION,
				variables: { environmentId: target.environmentId },
				onNext: (data) => {
					// `environmentLogs` streams either one entry or an array per tick.
					const payload =
						typeof data === "object" && data !== null
							? (data as { environmentLogs?: unknown }).environmentLogs
							: undefined
					const items = Array.isArray(payload) ? payload : payload !== undefined ? [payload] : []
					for (const item of items) {
						const entry = decodeRailwayLogEntry(item)
						if (entry !== null) enqueueLogEntry(state, entry)
					}
				},
					...(deps.webSocketFactory !== undefined
						? { webSocketFactory: deps.webSocketFactory }
						: {}),
				}),
			)

			const now = yield* Clock.currentTimeMillis
			const connectionLastedMs = now - connectedAt
			consecutiveFailures = connectionLastedMs >= STABLE_CONNECTION_MS ? 1 : consecutiveFailures + 1

			const message = Result.isFailure(outcome)
				? outcome.failure.message
				: "subscription ended unexpectedly"
			const unauthorized = Result.isFailure(outcome) ? outcome.failure.unauthorized : false

			yield* deps.enqueueReport(
				new RailwayResultReport({
					targetId: target.id,
					kind: "logs",
					at: now,
					error: `log stream disconnected: ${message}`,
					...(unauthorized ? { unauthorized: true } : {}),
				}),
			)
			const delayMs = reconnectDelayMs(consecutiveFailures)
			yield* Effect.logWarning("Railway log stream disconnected, reconnecting").pipe(
				Effect.annotateLogs({
					targetId: target.id,
					orgId: target.orgId,
					error: message,
					delayMs,
					unauthorized,
				}),
			)
			yield* Effect.sleep(Duration.millis(delayMs))
		}
	}) as Effect.Effect<never>
