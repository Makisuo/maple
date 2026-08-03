import type { Queue } from "@cloudflare/workers-types"
import { OrgId } from "@maple/domain/http"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PlanetScaleWebhookPayload } from "./webhook-events"

const QUEUE_BINDING = "PLANETSCALE_WEBHOOK_QUEUE"

export const PlanetScaleWebhookJob = Schema.Struct({
	kind: Schema.Literal("planetscale-webhook"),
	orgId: OrgId,
	connectionId: Schema.String,
	payload: PlanetScaleWebhookPayload,
	receivedAt: Schema.Number,
})
export type PlanetScaleWebhookJob = Schema.Schema.Type<typeof PlanetScaleWebhookJob>

export class PlanetScaleWebhookQueueError extends Data.TaggedError(
	"@maple/api/services/planetscale/PlanetScaleWebhookQueueError",
)<{
	readonly message: string
	readonly cause?: unknown
}> {}

export interface PlanetScaleWebhookQueueShape {
	readonly send: (job: PlanetScaleWebhookJob) => Effect.Effect<void, PlanetScaleWebhookQueueError>
}

const encodeJob = Schema.encodeSync(PlanetScaleWebhookJob)

export class PlanetScaleWebhookQueue extends Context.Service<
	PlanetScaleWebhookQueue,
	PlanetScaleWebhookQueueShape
>()("@maple/api/services/planetscale/PlanetScaleWebhookQueue", {
	make: Effect.gen(function* () {
		const workerEnv = yield* WorkerEnvironment
		const queue = workerEnv[QUEUE_BINDING] as Queue<unknown> | undefined

		const send = Effect.fn("PlanetScaleWebhookQueue.send")(function* (job: PlanetScaleWebhookJob) {
			yield* Effect.annotateCurrentSpan({
				"maple.planetscale.webhook.job.kind": job.kind,
				orgId: job.orgId,
			})
			if (queue === undefined) {
				return yield* new PlanetScaleWebhookQueueError({
					message: `Missing queue binding: ${QUEUE_BINDING}`,
				})
			}
			yield* Effect.tryPromise({
				try: () => queue.send(encodeJob(job)),
				catch: (cause) =>
					new PlanetScaleWebhookQueueError({
						message: cause instanceof Error ? cause.message : "PlanetScale queue send failed",
						cause,
					}),
			})
		})

		return { send } satisfies PlanetScaleWebhookQueueShape
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
