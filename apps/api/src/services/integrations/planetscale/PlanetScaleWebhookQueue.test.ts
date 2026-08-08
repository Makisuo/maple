import { assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { WorkerEnvironment } from "@maple/effect-cloudflare"
import { Effect, Layer, Schema } from "effect"
import { projectPlanetScaleWebhookEvent } from "./webhook-events"
import { PlanetScaleWebhookQueue, type PlanetScaleWebhookJob } from "./PlanetScaleWebhookQueue"

const orgId = Schema.decodeUnknownSync(OrgId)("org_1")
const payload = {
	event: "branch.anomaly",
	organization: "acme",
	database: "shop",
	resource: { name: "main" },
}
const job: PlanetScaleWebhookJob = {
	kind: "planetscale-webhook",
	orgId,
	connectionId: "connection_1",
	payload,
	receivedAt: 1_000,
	event: projectPlanetScaleWebhookEvent({
		orgId,
		connectionId: "connection_1",
		payload,
		receivedAt: 1_000,
	}),
}

const provideQueue = (environment: Record<string, unknown>) =>
	Effect.provide(
		PlanetScaleWebhookQueue.layer.pipe(Layer.provide(Layer.succeed(WorkerEnvironment, environment))),
	)

describe("PlanetScaleWebhookQueue", () => {
	it.effect("schema-encodes the internal job onto the dedicated binding", () => {
		const sent: unknown[] = []
		return Effect.gen(function* () {
			const queue = yield* PlanetScaleWebhookQueue
			yield* queue.send(job)
			assert.deepStrictEqual(sent, [job])
		}).pipe(
			provideQueue({
				PLANETSCALE_WEBHOOK_QUEUE: {
					send: async (body: unknown) => {
						sent.push(body)
					},
				},
			}),
		)
	})

	it.effect("fails with a typed error when the binding is absent", () =>
		Effect.gen(function* () {
			const queue = yield* PlanetScaleWebhookQueue
			const error = yield* queue.send(job).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/api/services/planetscale/PlanetScaleWebhookQueueError")
		}).pipe(provideQueue({})),
	)

	it.effect("maps binding rejections to the typed queue error", () => {
		let attempts = 0
		return Effect.gen(function* () {
			const queue = yield* PlanetScaleWebhookQueue
			const error = yield* queue.send(job).pipe(Effect.flip)
			assert.strictEqual(error._tag, "@maple/api/services/planetscale/PlanetScaleWebhookQueueError")
			assert.strictEqual(error.message, "simulated queue outage")
			assert.strictEqual(attempts, 1)
		}).pipe(
			provideQueue({
				PLANETSCALE_WEBHOOK_QUEUE: {
					send: async () => {
						attempts += 1
						throw new Error("simulated queue outage")
					},
				},
			}),
		)
	})
})
