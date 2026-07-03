import type { MessageBatch } from "@cloudflare/workers-types"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_TAGS } from "@maple/domain/anticipated-errors"
import { WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { Cause, Effect, Layer, Option } from "effect"
import { DatabasePgLive } from "./lib/DatabasePgLive"
import { Env } from "./lib/Env"
import { GithubAppClient } from "./services/vcs/vendor/github/GithubAppClient"
import { GithubHttp } from "./services/vcs/vendor/github/GithubHttp"
import { GithubProvider } from "./services/vcs/vendor/github/GithubProvider"
import { VcsProviderRegistry } from "./services/vcs/VcsProviderRegistry"
import { VcsRepository } from "./services/vcs/VcsRepository"
import { VcsScheduledSyncService } from "./services/vcs/VcsScheduledSyncService"
import { clampQueueDelaySeconds, VcsSyncQueue } from "./services/vcs/VcsSyncQueue"
import { VcsSyncService } from "./services/vcs/VcsSyncService"

// ---------------------------------------------------------------------------
// Per-invocation runtime for the `VCS_SYNC_QUEUE` consumer. Mirrors the
// alerting worker's `buildLayer`: its own light layer graph (NOT the fetch
// path's MainLive) so the queue invocation stays within the startup CPU budget.
// ---------------------------------------------------------------------------

const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	anticipatedErrorTags: [...ANTICIPATED_ERROR_TAGS],
})

export const buildVcsSyncLayer = (_env: Record<string, unknown>) => {
	const ConfigLive = WorkerConfigProviderLayer
	const EnvLive = Env.layer.pipe(Layer.provide(ConfigLive))
	const DatabaseLive = DatabasePgLive.pipe(Layer.provide(WorkerEnvironment.layer))
	const Base = Layer.mergeAll(EnvLive, DatabaseLive, WorkerEnvironment.layer)

	const VcsRepositoryLive = VcsRepository.layer.pipe(Layer.provide(Base))
	const GithubAppClientLive = GithubAppClient.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, GithubHttp.layer)),
	)
	const GithubProviderLive = GithubProvider.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, GithubAppClientLive)),
	)
	const VcsProviderRegistryLive = VcsProviderRegistry.layer.pipe(Layer.provide(GithubProviderLive))
	const VcsSyncQueueLive = VcsSyncQueue.layer.pipe(Layer.provide(WorkerEnvironment.layer))
	const VcsSyncServiceLive = VcsSyncService.layer.pipe(
		Layer.provide(Layer.mergeAll(VcsRepositoryLive, VcsProviderRegistryLive, VcsSyncQueueLive)),
	)

	return VcsSyncServiceLive.pipe(Layer.provideMerge(telemetry.layer), Layer.provideMerge(ConfigLive))
}

// The periodic (cron) producer's layer graph. Deliberately lighter than the
// consumer's: enqueuing installation-sync jobs needs only storage + the queue —
// NOT the provider registry (the consumer does all provider work).
export const buildVcsScheduledLayer = (_env: Record<string, unknown>) => {
	const ConfigLive = WorkerConfigProviderLayer
	const EnvLive = Env.layer.pipe(Layer.provide(ConfigLive))
	const DatabaseLive = DatabasePgLive.pipe(Layer.provide(WorkerEnvironment.layer))
	const Base = Layer.mergeAll(EnvLive, DatabaseLive, WorkerEnvironment.layer)

	const VcsRepositoryLive = VcsRepository.layer.pipe(Layer.provide(Base))
	const VcsSyncQueueLive = VcsSyncQueue.layer.pipe(Layer.provide(WorkerEnvironment.layer))
	const VcsScheduledSyncServiceLive = VcsScheduledSyncService.layer.pipe(
		Layer.provide(Layer.mergeAll(VcsRepositoryLive, VcsSyncQueueLive)),
	)

	return VcsScheduledSyncServiceLive.pipe(
		Layer.provideMerge(telemetry.layer),
		Layer.provideMerge(ConfigLive),
	)
}

export const flushVcsTelemetry = (env: Record<string, unknown>) => telemetry.flush(env)

// The cron program: enqueue a periodic refresh per processable installation.
export const runScheduledSync = Effect.gen(function* () {
	const scheduler = yield* VcsScheduledSyncService
	const result = yield* scheduler.runScheduledSync()
	// Duplicate counts onto the tick span so cron-level traces are filterable without drilling into child spans.
	yield* Effect.annotateCurrentSpan({
		"vcs.scheduled.installations_total": result.installationsTotal,
		"vcs.scheduled.enqueued": result.enqueued,
		"vcs.scheduled.skipped": result.skipped,
	})
	yield* Effect.annotateCurrentSpan({ "vcs.scheduled.outcome": "completed" })
	yield* Effect.logInfo("[VCS] scheduled sync tick complete").pipe(
		Effect.annotateLogs({
			installationsTotal: result.installationsTotal,
			enqueued: result.enqueued,
			skipped: result.skipped,
		}),
	)
}).pipe(
	// tapCause lets the cause propagate so `withSpan` marks `VcsScheduledSync.tick` as Error.
	Effect.tapCause((cause) =>
		Effect.annotateCurrentSpan({ "vcs.scheduled.outcome": "failed" }).pipe(
			Effect.flatMap(() =>
				Effect.logError("[VCS] scheduled sync tick failed").pipe(
					Effect.annotateLogs({ error: Cause.pretty(cause) }),
				),
			),
		),
	),
	Effect.withSpan("VcsScheduledSync.tick"),
)

// Must match `max_retries` in wrangler.jsonc / alchemy.run.ts. No DLQ exists, so on the
// final delivery (attempt > max_retries) we persist a terminal status instead of silently dropping.
const VCS_SYNC_MAX_RETRIES = 3

export const processBatch = (batch: MessageBatch<unknown>) =>
	Effect.gen(function* () {
		const service = yield* VcsSyncService
		yield* Effect.forEach(
			batch.messages,
			(message) =>
				service.processMessage(message.body).pipe(
					Effect.matchCauseEffect({
						onFailure: (cause) => {
							// Rate-limited: delay redelivery until the VCS budget resets instead of retrying immediately.
							const failure = Option.getOrUndefined(Cause.findErrorOption(cause))
							const isRateLimited = failure?._tag === "@maple/http/errors/VcsRateLimitedError"

							const delaySeconds = isRateLimited
								? clampQueueDelaySeconds(failure.retryAfterSeconds)
								: undefined
							const isDelaySecondsSet = delaySeconds !== undefined
							// Last retry exhausted: persist terminal status so repos don't get stuck backfilling, then ack.
							const isFinalAttempt = message.attempts > VCS_SYNC_MAX_RETRIES

							// Low-cardinality outcome label — full Cause stays in the log, not the span.
							const outcome = isFinalAttempt
								? "exhausted"
								: isDelaySecondsSet
									? "retry_delayed"
									: "retry"

							return Effect.annotateCurrentSpan({
								"vcs.queue.message.outcome": outcome,
								// Tag rate-limit errors so `retry_delayed`/`exhausted` spans are filterable without parsing logs.
								...(isRateLimited
									? { "vcs.queue.failure.tag": "@maple/http/errors/VcsRateLimitedError" }
									: {}),
								...(isDelaySecondsSet
									? { "vcs.queue.retry.delay_seconds": delaySeconds }
									: {}),
							}).pipe(
								Effect.flatMap(() =>
									Effect.logError("[VCS] sync message failed").pipe(
										Effect.annotateLogs({
											error: Cause.pretty(cause),
											attempt: message.attempts,
											outcome,
											...(isFinalAttempt ? { exhausted: true } : {}),
											...(isDelaySecondsSet ? { retryDelaySeconds: delaySeconds } : {}),
										}),
									),
								),
								Effect.flatMap(() =>
									isFinalAttempt
										? service
												.recordExhaustedFailure(message.body)
												.pipe(Effect.flatMap(() => Effect.sync(() => message.ack())))
										: Effect.sync(() =>
												isDelaySecondsSet
													? message.retry({ delaySeconds })
													: message.retry(),
											),
								),
							)
						},
						onSuccess: () =>
							Effect.annotateCurrentSpan({
								"vcs.queue.message.outcome": "succeeded_ack",
							}).pipe(Effect.flatMap(() => Effect.sync(() => message.ack()))),
					}),
					Effect.withSpan("VcsSyncQueue.processMessage", {
						attributes: { "messaging.message.delivery_attempt": message.attempts },
					}),
				),
			{ discard: true },
		)
	}).pipe(
		Effect.withSpan("VcsSyncQueue.processBatch", {
			attributes: { "messaging.batch.message_count": batch.messages.length },
		}),
	)
