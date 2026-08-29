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
 * Audit events queue consumer: lowers each event to its `audit_log_entries`
 * row. The `(org_id, id)` primary key plus `onConflictDoNothing` makes queue
 * redelivery idempotent; insert failures retry through the queue's policy.
 */
export const processAuditEventsBatch = (batch: MessageBatch<unknown>) =>
	Effect.gen(function* () {
		const database = yield* Database
		yield* Effect.forEach(
			batch.messages,
			(message) =>
				decodeAuditLogEvent(message.body).pipe(
					Effect.matchEffect({
						onFailure: (error) =>
							Effect.logWarning("Discarding malformed audit event queue message").pipe(
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
								Effect.catchCause((cause) =>
									Effect.logWarning("Audit event insert failed; retrying").pipe(
										Effect.annotateLogs({ attempt: message.attempts, error: String(cause) }),
										Effect.flatMap(() => Effect.sync(() => message.retry())),
									),
								),
							),
					}),
				),
			{ concurrency: 5, discard: true },
		)
	}).pipe(Effect.withSpan("auditEvents.processBatch"))
