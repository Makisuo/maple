/**
 * Per-(target × service) metrics polling: one `metrics` GraphQL query per
 * service per interval requesting all measurements at once, converted to
 * OTLP gauges and pushed through the ingest gateway. Delays adapt to
 * Railway's rate-limit headers (see RailwayGraphql.nextPollDelayMs).
 */
import { Clock, Duration, Effect, Result, type Semaphore } from "effect"
import { RailwayResultReport, type InternalRailwayTarget } from "@maple/domain/http"
import {
	buildMetricsExportRequest,
	decodeRailwayMetrics,
	RAILWAY_MEASUREMENTS,
} from "./otlp/metrics"
import { nextPollDelayMs, type RailwayGraphqlShape } from "./RailwayGraphql"
import type { OtlpIngestShape } from "./OtlpIngest"

/** Never ask Railway for more than this much history in one poll window. */
export const MAX_WINDOW_MS = Duration.toMillis(Duration.hours(1))

export const METRICS_QUERY = `
query mapleServiceMetrics($environmentId: String!, $serviceId: String!, $startDate: DateTime!, $endDate: DateTime!, $sampleRateSeconds: Int, $measurements: [MetricMeasurement!]!) {
  metrics(environmentId: $environmentId, serviceId: $serviceId, startDate: $startDate, endDate: $endDate, sampleRateSeconds: $sampleRateSeconds, measurements: $measurements) {
    measurement
    values {
      ts
      value
    }
  }
}
`

/**
 * The poll window `[startMs, endMs]`: resumes from the watermark, clamped so
 * a long-disabled target does not request unbounded history.
 */
export const pollWindow = (
	nowMs: number,
	watermarkMs: number | null,
	intervalMs: number,
): { readonly startMs: number; readonly endMs: number } => {
	const start = watermarkMs ?? nowMs - intervalMs
	return { startMs: Math.max(start, nowMs - MAX_WINDOW_MS), endMs: nowMs }
}

/** Deterministic per-loop start delay in `[0, baseMs)` (FNV-1a) so the services of one token don't poll in a synchronized burst. */
export const initialJitterMs = (key: string, baseMs: number): number => {
	if (baseMs <= 0) return 0
	let hash = 0x811c9dc5
	for (let i = 0; i < key.length; i++) {
		hash ^= key.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0) % baseMs
}

export interface MetricsPollerDeps {
	readonly graphql: RailwayGraphqlShape
	readonly otlp: Pick<OtlpIngestShape, "sendMetrics">
	readonly enqueueReport: (report: RailwayResultReport) => Effect.Effect<void>
	/** Global cap on concurrent Railway polls across all targets. */
	readonly semaphore: Semaphore.Semaphore
}

/** Run one service's metrics poll loop forever. */
export const runMetricsPoller = (
	target: InternalRailwayTarget,
	service: { readonly id: string; readonly name: string },
	deps: MetricsPollerDeps,
): Effect.Effect<never> => {
	const baseMs = target.metricsIntervalSeconds * 1000

	interface PollOutcome {
		readonly error: string | null
		readonly unauthorized: boolean
		readonly rateLimited: boolean
		readonly retryAfterMs: number | null
		readonly remaining: number | null
	}

	return Effect.gen(function* () {
		let watermarkMs = target.metricsWatermarkMs

		const pollOnce: Effect.Effect<PollOutcome> = deps.semaphore.withPermits(1)(
			Effect.gen(function* () {
				const nowMs = yield* Clock.currentTimeMillis
				const { startMs, endMs } = pollWindow(nowMs, watermarkMs, baseMs)

				const result = yield* Effect.result(
					deps.graphql.query(target.token, {
						query: METRICS_QUERY,
						variables: {
							environmentId: target.environmentId,
							serviceId: service.id,
							startDate: new Date(startMs).toISOString(),
							endDate: new Date(endMs).toISOString(),
							sampleRateSeconds: Math.max(60, target.metricsIntervalSeconds),
							measurements: [...RAILWAY_MEASUREMENTS],
						},
					}),
				)

				if (Result.isFailure(result)) {
					const error = result.failure
					yield* deps.enqueueReport(
						new RailwayResultReport({
							targetId: target.id,
							kind: "metrics",
							at: nowMs,
							error: error.message,
							...(error.unauthorized ? { unauthorized: true } : {}),
							...(error.rateLimited ? { rateLimited: true } : {}),
						}),
					)
					return {
						error: error.message,
						unauthorized: error.unauthorized,
						rateLimited: error.rateLimited,
						retryAfterMs: error.retryAfterMs,
						remaining: null,
					} satisfies PollOutcome
				}

				const series = decodeRailwayMetrics(result.success.data)
				const batch = buildMetricsExportRequest(
					series,
					{
						serviceName: service.name,
						serviceId: service.id,
						projectId: target.projectId,
						projectName: target.projectName,
						environmentId: target.environmentId,
						environmentName: target.environmentName,
					},
					watermarkMs,
				)

				if (batch.request !== null) {
					const sent = yield* Effect.result(deps.otlp.sendMetrics(target.ingestKey, batch.request))
					if (Result.isFailure(sent)) {
						// The watermark stays put so the samples are re-fetched next poll
						// (dedupe happens via the watermark filter on conversion).
						yield* deps.enqueueReport(
							new RailwayResultReport({
								targetId: target.id,
								kind: "metrics",
								at: nowMs,
								error: sent.failure.message,
							}),
						)
						return {
							error: sent.failure.message,
							unauthorized: false,
							rateLimited: false,
							retryAfterMs: null,
							remaining: result.success.rate.remaining,
						} satisfies PollOutcome
					}
				}

				if (batch.maxSampleMs !== null && (watermarkMs === null || batch.maxSampleMs > watermarkMs)) {
					watermarkMs = batch.maxSampleMs
				}
				yield* deps.enqueueReport(
					new RailwayResultReport({
						targetId: target.id,
						kind: "metrics",
						at: nowMs,
						error: null,
						recordsIngested: batch.dataPointCount,
						...(watermarkMs !== null ? { newMetricsWatermarkMs: watermarkMs } : {}),
					}),
				)
				return {
					error: null,
					unauthorized: false,
					rateLimited: false,
					retryAfterMs: null,
					remaining: result.success.rate.remaining,
				} satisfies PollOutcome
			}).pipe(
				Effect.withSpan("railway.poll_metrics", {
					attributes: {
						orgId: target.orgId,
						targetId: target.id,
						serviceId: service.id,
						serviceName: service.name,
						intervalSeconds: target.metricsIntervalSeconds,
					},
				}),
			),
		)

		let consecutiveRateLimits = 0
		// De-sync the services sharing this token so polls spread across the
		// interval instead of bursting together against the hourly budget.
		yield* Effect.sleep(Duration.millis(initialJitterMs(`${target.id}:${service.id}`, baseMs)))
		while (true) {
			const startedAt = yield* Clock.currentTimeMillis
			const outcome = yield* pollOnce
			const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt

			if (outcome.error !== null) {
				yield* Effect.logWarning("Railway metrics poll failed").pipe(
					Effect.annotateLogs({
						targetId: target.id,
						orgId: target.orgId,
						serviceId: service.id,
						error: outcome.error,
					}),
				)
			}

			consecutiveRateLimits = outcome.rateLimited ? consecutiveRateLimits + 1 : 0
			const delayMs = nextPollDelayMs({
				baseMs,
				rateLimited: outcome.rateLimited,
				retryAfterMs: outcome.retryAfterMs,
				remaining: outcome.remaining,
				consecutiveRateLimits: Math.max(0, consecutiveRateLimits - 1),
			})
			// Happy-path cadence stays start-to-start; backoff runs the full delay
			// from poll end so Retry-After is honored.
			const sleepMs = outcome.rateLimited ? delayMs : Math.max(0, delayMs - elapsedMs)
			yield* Effect.sleep(Duration.millis(sleepMs))
		}
	}) as Effect.Effect<never>
}
