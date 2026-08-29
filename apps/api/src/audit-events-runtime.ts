import type { MessageBatch } from "@cloudflare/workers-types"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import { WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { auditLogEntries } from "@maple/db"
import { Clock, Effect, Layer } from "effect"
import { layerPg } from "@/platform/DatabasePgLive"
import { Database } from "@/platform/DatabaseLive"
import { auditEventToInsert, decodeAuditLogEvent } from "./services/audit/audit-event"

const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "core",
	repositoryUrl: "https://github.com/MapleTechLabs/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

export const buildAuditEventsLayer = (_env: Record<string, unknown>) => {
	const DatabaseLive = layerPg.pipe(Layer.provide(WorkerEnvironment.layer))
	return DatabaseLive.pipe(
		Layer.provideMerge(telemetry.layer),
		Layer.provideMerge(WorkerEnvironment.layer),
		Layer.provideMerge(WorkerConfigProviderLayer),
	)
}

export const flushAuditEventsTelemetry = (env: Record<string, unknown>) => telemetry.flush(env)

/**
 * Must match `maxRetries` on the audit-events consumer in `alchemy.run.ts` and
 * `wrangler.jsonc`. Cloudflare routes the message to the DLQ after this many
 * retries without telling us; the check below is what makes the hand-off
 * visible in logs at the moment it happens.
 */
const AUDIT_EVENTS_MAX_RETRIES = 5

/**
 * Best-effort identity for the exhaustion log. The body reached us as queue
 * JSON and may be anything at all, so these read defensively rather than
 * decoding — a drop must still be reported when the payload is the problem.
 */
const auditEventField = (body: unknown, field: string): string => {
	if (typeof body !== "object" || body === null || !(field in body)) return "<unknown>"
	// SAFETY: `field in body` established the key exists on this object.
	const value = (body as Record<string, unknown>)[field]
	return typeof value === "string" ? value : "<unknown>"
}
const auditEventOrgId = (body: unknown) => auditEventField(body, "orgId")
const auditEventAction = (body: unknown) => auditEventField(body, "action")

/**
 * Audit events queue consumer: lowers each event to its `audit_log_entries`
 * row. The `(org_id, id)` primary key plus `onConflictDoNothing` makes queue
 * redelivery idempotent; insert failures retry through the queue's policy and,
 * once exhausted, land in `audit-events-dlq` rather than disappearing.
 */
export const processAuditEventsBatch = (batch: MessageBatch<unknown>) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* Effect.forEach(
			batch.messages,
			(message) =>
				decodeAuditLogEvent(message.body).pipe(
					Effect.matchEffect({
						// Undecodable now means undecodable on every redelivery, so retrying
						// only burns attempts. Acked, but at Error: an audit entry that
						// never reaches a row is lost evidence, not routine noise.
						onFailure: (error) =>
							Effect.logError("Discarding malformed audit event queue message").pipe(
								Effect.annotateLogs({ attempt: message.attempts, error: String(error) }),
								Effect.flatMap(() => Effect.sync(() => message.ack())),
							),
						onSuccess: (event) =>
							Effect.gen(function* () {
								const now = yield* Clock.currentTimeMillis
								yield* database.execute((db) =>
									db
										.insert(auditLogEntries)
										.values(auditEventToInsert(event, now))
										.onConflictDoNothing(),
								)
								yield* Effect.sync(() => message.ack())
							}).pipe(
								Effect.withSpan("auditEvents.processMessage"),
								Effect.catchCause((cause) => {
									// Retrying past the limit is what hands the message to the
									// DLQ; acking here would silently discard it instead.
									const isFinalAttempt = message.attempts > AUDIT_EVENTS_MAX_RETRIES
									const outcome = isFinalAttempt ? "exhausted_dlq" : "retry"
									return Effect.annotateCurrentSpan({
										"audit.queue.message.outcome": outcome,
									}).pipe(
										Effect.flatMap(() =>
											isFinalAttempt
												? Effect.logError(
														"Audit event exhausted retries; routed to dead letter queue",
													).pipe(
														Effect.annotateLogs({
															attempt: message.attempts,
															orgId: auditEventOrgId(message.body),
															action: auditEventAction(message.body),
															error: String(cause),
														}),
													)
												: Effect.logWarning("Audit event insert failed; retrying").pipe(
														Effect.annotateLogs({
															attempt: message.attempts,
															error: String(cause),
														}),
													),
										),
										Effect.flatMap(() => Effect.sync(() => message.retry())),
									)
								}),
							),
					}),
				),
			{ concurrency: 5, discard: true },
		)
	}).pipe(Effect.withSpan("auditEvents.processBatch"))
