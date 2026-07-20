import type { Queue } from "@cloudflare/workers-types"
import { VcsQueueError, VcsSyncJob } from "@maple/domain/http"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Context, Effect, Layer, Schema } from "effect"

// ---------------------------------------------------------------------------
// Vendor-agnostic queue producer. Reads the `VCS_SYNC_QUEUE` binding from the
// worker env and sends Schema-encoded `VcsSyncJob`s. The same queue carries
// jobs for every provider (discriminated by `job.provider`).
// ---------------------------------------------------------------------------

const QUEUE_BINDING = "VCS_SYNC_QUEUE"
const encodeJob = Schema.encodeSync(VcsSyncJob)

// Cloudflare Queues transport limits, owned here (the only module that talks to
// the binding). Producers that must pre-size their payloads — e.g. a provider
// splitting a large push so each job fits — import these rather than hardcoding
// the platform's magic numbers.
export const QUEUE_MESSAGE_LIMIT_BYTES = 128 * 1024 // max serialized message size
const QUEUE_MAX_DELAY_SECONDS = 86_400 // max visibility delay (24h)
// A single `sendBatch` call accepts at most 100 messages OR 256 KB of payload,
// whichever comes first. `sendBatch` packs jobs into chunks under BOTH bounds so
// callers can hand it an arbitrarily long list without pre-chunking.
export const QUEUE_BATCH_MAX_MESSAGES = 100
export const QUEUE_BATCH_MAX_BYTES = 256 * 1024

// Coerce a requested delay into the range Cloudflare accepts: a whole number of
// seconds in [0, 86_400]. Out-of-range/fractional values cause the binding to
// reject the send outright.
export const clampQueueDelaySeconds = (seconds: number): number =>
	Math.min(Math.max(0, Math.floor(seconds)), QUEUE_MAX_DELAY_SECONDS)

// Serialized byte size of a message body (UTF-8) — the basis for Cloudflare's per-batch byte cap.
const textEncoder = new TextEncoder()
const jsonByteLength = (body: unknown): number => textEncoder.encode(JSON.stringify(body)).length

export interface VcsSyncQueueShape {
	/**
	 * Enqueue a job. `delaySeconds` (0–86,400) holds it invisible until the delay
	 * elapses — used to requeue a rate-limited backfill continuation only once the
	 * provider's budget is back.
	 */
	readonly send: (
		job: VcsSyncJob,
		options?: { readonly delaySeconds?: number },
	) => Effect.Effect<void, VcsQueueError>
	readonly sendBatch: (jobs: ReadonlyArray<VcsSyncJob>) => Effect.Effect<void, VcsQueueError>
}

export class VcsSyncQueue extends Context.Service<VcsSyncQueue, VcsSyncQueueShape>()(
	"@maple/api/services/vcs/VcsSyncQueue",
	{
		make: Effect.gen(function* () {
			const workerEnv = yield* WorkerEnvironment
			const queue = workerEnv[QUEUE_BINDING] as Queue<unknown> | undefined

			const send = Effect.fn("VcsSyncQueue.send")(function* (
				job: VcsSyncJob,
				options?: { readonly delaySeconds?: number },
			) {
				yield* Effect.annotateCurrentSpan({ "vcs.job.kind": job.kind, "vcs.provider": job.provider })
				if (!queue) {
					return yield* new VcsQueueError({ message: `Missing queue binding: ${QUEUE_BINDING}` })
				}
				const body = encodeJob(job)
				const sendOptions =
					options?.delaySeconds === undefined
						? undefined
						: { delaySeconds: clampQueueDelaySeconds(options.delaySeconds) }
				yield* Effect.tryPromise({
					try: () => queue.send(body, sendOptions),
					catch: (cause) =>
						new VcsQueueError({
							message: cause instanceof Error ? cause.message : "queue send failed",
						}),
				})
			})

			const sendBatch = Effect.fn("VcsSyncQueue.sendBatch")(function* (
				jobs: ReadonlyArray<VcsSyncJob>,
			) {
				// Count + distinct kinds only — a fixed, low-cardinality summary. A batch can
				// hold hundreds of jobs, so a raw kind-per-job list would be unbounded and
				// redundant with the count.
				yield* Effect.annotateCurrentSpan({
					"vcs.jobs.length": jobs.length,
					"vcs.job.kinds": [...new Set(jobs.map((j) => j.kind))].sort().join(","),
				})
				if (jobs.length === 0) return
				if (!queue) {
					return yield* new VcsQueueError({ message: `Missing queue binding: ${QUEUE_BINDING}` })
				}

				// Encode once, then greedily pack into chunks bounded by BOTH the message
				// count and the byte cap Cloudflare accepts per `sendBatch`. A single job
				// over the per-message cap is sent on its own (Cloudflare rejects it,
				// surfacing as VcsQueueError) rather than silently dropped.
				const sized = jobs.map((job) => {
					const body = encodeJob(job)
					return { message: { body }, size: jsonByteLength(body) }
				})
				const chunks: Array<Array<{ body: unknown }>> = []
				let current: Array<{ body: unknown }> = []
				let currentBytes = 0
				for (const { message, size } of sized) {
					const wouldOverflow =
						current.length >= QUEUE_BATCH_MAX_MESSAGES ||
						(current.length > 0 && currentBytes + size > QUEUE_BATCH_MAX_BYTES)
					if (wouldOverflow) {
						chunks.push(current)
						current = []
						currentBytes = 0
					}
					current.push(message)
					currentBytes += size
				}
				if (current.length > 0) chunks.push(current)

				yield* Effect.annotateCurrentSpan({ "vcs.jobs.batches": chunks.length })
				yield* Effect.forEach(
					chunks,
					(chunk) =>
						Effect.tryPromise({
							try: () => queue.sendBatch(chunk),
							catch: (cause) =>
								new VcsQueueError({
									message:
										cause instanceof Error ? cause.message : "queue sendBatch failed",
								}),
						}),
					{ discard: true },
				)
			})

			return { send, sendBatch } satisfies VcsSyncQueueShape
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
