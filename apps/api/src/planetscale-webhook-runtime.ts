import type { MessageBatch } from "@cloudflare/workers-types"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { Effect, Layer, Schema } from "effect"
import { layerPg } from "@/platform/DatabasePgLive"
import type { Database, DatabaseError } from "@/platform/DatabaseLive"
import {
	classifyPlanetScaleEvent,
	deployRequestNumber,
	insertPlanetScaleEvent,
	planetScaleBranchName,
	upsertPlanetScaleIssue,
} from "./services/integrations/planetscale/webhook-events"
import { PlanetScaleWebhookJob } from "./services/integrations/planetscale/PlanetScaleWebhookQueue"

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
						if (classified.action !== "issue" && classified.action !== "timeline") {
							return annotateJob.pipe(
								Effect.flatMap(() =>
									Effect.logInfo(
										"PlanetScale webhook queue message no longer requires persistence",
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

						const spec = classified.timeline
						const timeline = insertPlanetScaleEvent({
							orgId: job.orgId,
							databaseName: job.payload.database ?? "unknown",
							branchName:
								spec.category === "deploy_request" ? "" : planetScaleBranchName(job.payload),
							category: spec.category,
							eventType: job.payload.event,
							state: spec.state,
							externalId:
								spec.category === "deploy_request" ? deployRequestNumber(job.payload) : "",
							title: spec.title(job.payload),
							source: "webhook",
							payload: job.payload.resource ?? null,
							occurredAtMs: timestamp,
							createdAtMs: job.receivedAt,
						}).pipe(
							Effect.withSpan("PlanetScaleWebhookQueue.persistTimelineEvent", {
								attributes: {
									orgId: job.orgId,
									"maple.planetscale.webhook.event": job.payload.event,
								},
							}),
						)

						// Timeline first: a retry after a failed issue upsert then re-runs
						// an idempotent insert rather than duplicating a chart marker.
						const persist: Effect.Effect<
							{ readonly issueId: string | null; readonly action: string },
							DatabaseError,
							Database
						> =
							classified.action === "timeline"
								? timeline.pipe(Effect.as({ issueId: null, action: "timeline" }))
								: timeline.pipe(
										Effect.flatMap(() =>
											upsertPlanetScaleIssue({
												orgId: job.orgId,
												payload: job.payload,
												severity: classified.severity,
												title: classified.title,
												description: classified.describe(job.payload),
												timestamp,
											}),
										),
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
									Effect.logError("PlanetScale webhook persistence failed").pipe(
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
									Effect.logInfo("PlanetScale webhook persisted").pipe(
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
												"maple.planetscale.webhook.queue.outcome":
													result.action === "timeline"
														? "timeline_ack"
														: "timeline_and_issue_ack",
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
