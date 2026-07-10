/**
 * The connector's reconcile loop (cloned from apps/scraper's ScrapeScheduler):
 * refresh the target list from the api on an interval, keep one log-stream
 * fiber per target and one metrics-poll fiber per (target, service), and
 * flush buffered result reports back to the api periodically.
 */
import { Clock, Context, Duration, Effect, Fiber, Layer, Ref, Result, Schedule, Semaphore } from "effect"
import type { InternalRailwayTarget, RailwayResultReport } from "@maple/domain/http"
import { ApiClient, type ApiRequestError } from "./ApiClient"
import { RailwayConnectorEnv } from "./Env"
import { runLogStream } from "./LogStream"
import { runMetricsPoller } from "./MetricsPoller"
import { OtlpIngest } from "./OtlpIngest"
import { RailwayGraphql } from "./RailwayGraphql"

interface SchedulerStats {
	readonly activeLoops: number
	readonly lastReconcileAt: number | null
	readonly pendingResults: number
}

export interface RailwaySchedulerShape {
	/**
	 * Run the connector forever: reconcile the target list on an interval,
	 * keep the per-target fibers alive, flush result reports periodically.
	 * Only exits on interruption.
	 */
	readonly run: Effect.Effect<never, ApiRequestError>
	readonly stats: Effect.Effect<SchedulerStats>
}

const RESULTS_FLUSH_INTERVAL = Duration.seconds(10)
/** Cap the report buffer so an unreachable API cannot grow memory unboundedly. */
const MAX_BUFFERED_RESULTS = 10_000
/** Max reports per `railway-results` POST (keeps single POSTs Worker-friendly). */
const RESULTS_FLUSH_CHUNK_SIZE = 1_000

/**
 * Send `results` to `send` in chunks, stopping at the first failed chunk.
 * Returns the results that were NOT delivered so the caller re-buffers just
 * those; `unsent` is empty when the whole batch went through.
 */
export const sendResultsInChunks = <E>(
	results: ReadonlyArray<RailwayResultReport>,
	chunkSize: number,
	send: (chunk: ReadonlyArray<RailwayResultReport>) => Effect.Effect<void, E>,
): Effect.Effect<{ readonly unsent: ReadonlyArray<RailwayResultReport>; readonly error: E | null }> =>
	Effect.gen(function* () {
		for (let index = 0; index < results.length; index += chunkSize) {
			const chunk = results.slice(index, index + chunkSize)
			const outcome = yield* Effect.result(send(chunk))
			if (Result.isFailure(outcome)) return { unsent: results.slice(index), error: outcome.failure }
		}
		return { unsent: [], error: null }
	})

export type LoopDescriptor =
	| { readonly kind: "logs"; readonly target: InternalRailwayTarget }
	| {
			readonly kind: "metrics"
			readonly target: InternalRailwayTarget
			readonly service: { readonly id: string; readonly name: string }
	  }

/** Fiber-map key: one log stream per target, one metrics loop per service. */
export const loopKey = (descriptor: LoopDescriptor): string =>
	descriptor.kind === "logs"
		? `${descriptor.target.id}:logs`
		: `${descriptor.target.id}:metrics:${descriptor.service.id}`

/**
 * Restart a loop when anything affecting its output changes. Watermarks are
 * deliberately EXCLUDED — they advance on every report and each running loop
 * tracks its own in memory; including them would restart every fiber on every
 * reconcile.
 */
export const loopFingerprint = (descriptor: LoopDescriptor): string => {
	const target = descriptor.target
	const common = [
		target.token,
		target.ingestKey,
		target.orgId,
		target.projectId,
		target.projectName,
		target.environmentId,
		target.environmentName,
	]
	if (descriptor.kind === "logs") {
		// The services map drives per-service resource attribution of log lines.
		return JSON.stringify([
			...common,
			"logs",
			descriptor.target.services.map((service) => [service.id, service.name]),
		])
	}
	return JSON.stringify([
		...common,
		"metrics",
		descriptor.service.id,
		descriptor.service.name,
		target.metricsIntervalSeconds,
	])
}

/** Expand a target into the loops it should be running. */
export const loopsForTarget = (target: InternalRailwayTarget): LoopDescriptor[] => [
	...(target.logsEnabled ? [{ kind: "logs", target } satisfies LoopDescriptor] : []),
	...(target.metricsEnabled
		? target.services.map(
				(service) =>
					({ kind: "metrics", target, service: { id: service.id, name: service.name } }) satisfies LoopDescriptor,
			)
		: []),
]

interface LoopEntry {
	readonly fingerprint: string
	readonly fiber: Fiber.Fiber<unknown, unknown>
}

export class RailwayScheduler extends Context.Service<RailwayScheduler, RailwaySchedulerShape>()(
	"@maple/railway-connector/Scheduler",
	{
		make: Effect.gen(function* () {
			const env = yield* RailwayConnectorEnv
			const api = yield* ApiClient
			const otlp = yield* OtlpIngest
			const graphql = yield* RailwayGraphql

			const semaphore = yield* Semaphore.make(env.RAILWAY_CONNECTOR_CONCURRENCY)
			const resultsRef = yield* Ref.make<ReadonlyArray<RailwayResultReport>>([])
			const fibersRef = yield* Ref.make(new Map<string, LoopEntry>())
			const lastReconcileRef = yield* Ref.make<number | null>(null)

			const enqueueReport = (report: RailwayResultReport) =>
				Ref.update(resultsRef, (buffered) =>
					buffered.length >= MAX_BUFFERED_RESULTS
						? [...buffered.slice(1), report]
						: [...buffered, report],
				)

			const runLoop = (descriptor: LoopDescriptor): Effect.Effect<never> =>
				descriptor.kind === "logs"
					? runLogStream(descriptor.target, {
							wsUrl: env.RAILWAY_GRAPHQL_WS_URL,
							otlp,
							enqueueReport,
						})
					: runMetricsPoller(descriptor.target, descriptor.service, {
							graphql,
							otlp,
							enqueueReport,
							semaphore,
						})

			const reconcile = Effect.gen(function* () {
				const targets = yield* api.listTargets()
				const current = yield* Ref.get(fibersRef)
				const next = new Map<string, LoopEntry>()

				// Collapse to one descriptor per key (last wins) so duplicate rows
				// can never leak untracked fibers across reconciles.
				const deduped = new Map<string, LoopDescriptor>()
				for (const target of targets) {
					for (const descriptor of loopsForTarget(target)) {
						deduped.set(loopKey(descriptor), descriptor)
					}
				}

				yield* Effect.forEach(
					deduped.entries(),
					([key, descriptor]) =>
						Effect.gen(function* () {
							const fingerprint = loopFingerprint(descriptor)
							const existing = current.get(key)
							if (existing && existing.fingerprint === fingerprint) {
								next.set(key, existing)
								return
							}
							if (existing) yield* Fiber.interrupt(existing.fiber)
							const fiber = yield* Effect.forkChild(runLoop(descriptor))
							next.set(key, { fingerprint, fiber })
						}),
					{ discard: true },
				)

				yield* Effect.forEach(
					current,
					([key, entry]) => (next.has(key) ? Effect.void : Fiber.interrupt(entry.fiber)),
					{ discard: true },
				)

				yield* Ref.set(fibersRef, next)
				yield* Ref.set(lastReconcileRef, yield* Clock.currentTimeMillis)
				yield* Effect.annotateCurrentSpan({ activeLoops: next.size, targets: targets.length })
			}).pipe(
				Effect.withSpan("railway.reconcile"),
				// A failed list fetch keeps the current fibers running untouched.
				Effect.catch((error) =>
					Effect.logWarning("Failed to refresh Railway target list").pipe(
						Effect.annotateLogs({ error: error.message }),
					),
				),
			)

			const flushResults = Effect.gen(function* () {
				const results = yield* Ref.getAndSet(resultsRef, [])
				if (results.length === 0) return
				const { unsent, error } = yield* sendResultsInChunks(
					results,
					RESULTS_FLUSH_CHUNK_SIZE,
					api.reportResults,
				)
				if (unsent.length > 0) {
					yield* Ref.update(resultsRef, (buffered) =>
						[...unsent, ...buffered].slice(-MAX_BUFFERED_RESULTS),
					)
					yield* Effect.logWarning("Failed to report Railway results").pipe(
						Effect.annotateLogs({
							error: error?.message ?? "unknown",
							bufferedResults: unsent.length,
						}),
					)
				}
			}).pipe(Effect.withSpan("railway.flush_results"))

			const run = Effect.gen(function* () {
				yield* Effect.forkChild(
					flushResults.pipe(Effect.repeat(Schedule.spaced(RESULTS_FLUSH_INTERVAL))),
				)
				return yield* reconcile.pipe(
					Effect.repeat(
						Schedule.spaced(Duration.seconds(env.RAILWAY_CONNECTOR_RECONCILE_INTERVAL_SECONDS)),
					),
					Effect.flatMap(() => Effect.never),
				)
			}) as Effect.Effect<never, ApiRequestError>

			const stats = Effect.gen(function* () {
				const fibers = yield* Ref.get(fibersRef)
				const lastReconcileAt = yield* Ref.get(lastReconcileRef)
				const pending = yield* Ref.get(resultsRef)
				return {
					activeLoops: fibers.size,
					lastReconcileAt,
					pendingResults: pending.length,
				} satisfies SchedulerStats
			})

			return { run, stats } satisfies RailwaySchedulerShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
