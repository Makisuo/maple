import type { MessageBatch } from "@cloudflare/workers-types"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { Effect, Layer, Schema } from "effect"
import { layerPg } from "./lib/DatabasePgLive"
import { classifyPlanetScaleEvent, upsertPlanetScaleIssue } from "./services/planetscale/webhook-events"
import { PlanetScaleWebhookJob } from "./services/planetscale/PlanetScaleWebhookQueue"

const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "backend",
	repositoryUrl: "https://github.com/Makisuo/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

export const buildPlanetScaleWebhookLayer = (_env: Record<string, unknown>) => {
	const DatabaseLive = layerPg.pipe(Layer.provide(WorkerEnvironment.layer))
	return DatabaseLive.pipe(
		Layer.provideMerge(telemetry.layer),
		Layer.provideMerge(WorkerEnvironment.layer),
		Layer.provideMerge(WorkerConfigProviderLayer),
	)
}

export const flushPlanetScaleWebhookTelemetry = (env: Record<string, unknown>) => telemetry.flush(env)

const decodeJob = Schema.decodeUnknownEffect(PlanetScaleWebhookJob)

export const processPlanetScaleWebhookBatch = (batch: MessageBatch<unknown>) =>
	Effect.forEach(
		batch.messages,
		(message) =>
			decodeJob(message.body).pipe(
				Effect.matchEffect({
					onFailure: (error) =>
						Effect.logWarning("Discarding malformed PlanetScale webhook queue message").pipe(
							Effect.annotateLogs({
								attempt: message.attempts,
								error: String(error),
							}),
							Effect.flatMap(() => Effect.sync(() => message.ack())),
							Effect.tap(() =>
								Effect.annotateCurrentSpan({
									"maple.planetscale.webhook.queue.outcome": "malformed_ack",
								}),
							),
						),
					onSuccess: (job) => {
						const classified = classifyPlanetScaleEvent(job.payload.event)
						const annotateJob = Effect.annotateCurrentSpan({
							orgId: job.orgId,
							"maple.planetscale.connection_id": job.connectionId,
							"maple.planetscale.webhook.event": job.payload.event,
						})
						if (classified.action !== "issue") {
							return annotateJob.pipe(
								Effect.flatMap(() =>
									Effect.logInfo(
										"PlanetScale webhook queue message no longer requires an issue",
									),
								),
								Effect.annotateLogs({
									orgId: job.orgId,
									connectionId: job.connectionId,
									event: job.payload.event,
								}),
								Effect.flatMap(() => Effect.sync(() => message.ack())),
							)
						}

						const timestamp =
							job.payload.timestamp != null && job.payload.timestamp > 0
								? job.payload.timestamp * 1000
								: job.receivedAt
						const persist = upsertPlanetScaleIssue({
							orgId: job.orgId,
							payload: job.payload,
							severity: classified.severity,
							title: classified.title,
							description: classified.describe(job.payload),
							timestamp,
						}).pipe(
							Effect.withSpan("PlanetScaleWebhookQueue.persistIssue", {
								attributes: {
									orgId: job.orgId,
									"maple.planetscale.connection_id": job.connectionId,
									"maple.planetscale.webhook.event": job.payload.event,
								},
							}),
						)
						return annotateJob.pipe(
							Effect.flatMap(() => persist),
							Effect.matchEffect({
								onFailure: (error) =>
									Effect.logError("PlanetScale webhook issue persistence failed").pipe(
										Effect.annotateLogs({
											orgId: job.orgId,
											connectionId: job.connectionId,
											event: job.payload.event,
											attempt: message.attempts,
											error: error.message,
										}),
										Effect.flatMap(() => Effect.sync(() => message.retry())),
										Effect.tap(() =>
											Effect.annotateCurrentSpan({
												"maple.planetscale.webhook.queue.outcome": "database_retry",
											}),
										),
									),
								onSuccess: (result) =>
									Effect.logInfo("PlanetScale webhook issue persisted").pipe(
										Effect.annotateLogs({
											orgId: job.orgId,
											connectionId: job.connectionId,
											event: job.payload.event,
											issueId: result.issueId,
											issueAction: result.action,
										}),
										Effect.flatMap(() => Effect.sync(() => message.ack())),
										Effect.tap(() =>
											Effect.annotateCurrentSpan({
												"maple.planetscale.webhook.queue.outcome": "persisted_ack",
												"maple.planetscale.webhook.issue_action": result.action,
											}),
										),
									),
							}),
						)
					},
				}),
				Effect.withSpan("PlanetScaleWebhookQueue.processMessage", {
					attributes: { "messaging.message.delivery_attempt": message.attempts },
				}),
			),
		{ concurrency: 5, discard: true },
	).pipe(
		Effect.withSpan("PlanetScaleWebhookQueue.processBatch", {
			attributes: { "messaging.batch.message_count": batch.messages.length },
		}),
	)
