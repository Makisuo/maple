import type { Message, MessageBatch } from "@cloudflare/workers-types"
import * as MapleCloudflareSDK from "@maple-dev/effect-sdk/cloudflare"
import { EdgeCacheService } from "@maple/cache"
import { ANTICIPATED_ERROR_IDENTIFIERS } from "@maple/domain/anticipated-errors"
import type { OrgId } from "@maple/domain/primitives"
import { WorkerConfigProviderLayer, WorkerEnvironment } from "@maple/effect-cloudflare"
import { Clock, Effect, Layer } from "effect"
import { CacheBackendLive } from "@/platform/CacheBackendLive"
import { layerPg } from "@/platform/DatabasePgLive"
import { Env } from "@/platform/Env"
import { systemTenant } from "@/services/alerts/system-tenant"
import { AUDIT_LOG_DATASOURCE } from "@/services/audit/AuditLogService"
import { OrgClickHouseSettingsService } from "@/services/org/OrgClickHouseSettingsService"
import { TinybirdOrgTokenService } from "@/services/integrations/TinybirdOrgTokenService"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { type AuditLogEvent, auditEventToRow, decodeAuditLogEvent } from "./services/audit/audit-event"

const telemetry = MapleCloudflareSDK.make({
	serviceName: "maple-api",
	serviceNamespace: "core",
	repositoryUrl: "https://github.com/MapleTechLabs/maple",
	anticipatedErrorIdentifiers: [...ANTICIPATED_ERROR_IDENTIFIERS],
})

/**
 * The consumer writes through `WarehouseQueryService.ingest`, which pins every
 * write to the managed Tinybird pipeline. The service's read-side dependencies
 * (org ClickHouse settings, the per-org JWT minter) come along because the
 * layer requires them, not because a write ever consults them.
 */
export const buildAuditEventsLayer = (_env: Record<string, unknown>) => {
	const EnvLive = Env.layer.pipe(Layer.provide(WorkerConfigProviderLayer))
	const DatabaseLive = layerPg.pipe(Layer.provide(WorkerEnvironment.layer))
	const EdgeCacheServiceLive = EdgeCacheService.layer.pipe(Layer.provide(CacheBackendLive))
	const OrgClickHouseSettingsLive = OrgClickHouseSettingsService.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, DatabaseLive, EdgeCacheServiceLive)),
	)
	const TinybirdOrgTokenLive = TinybirdOrgTokenService.layer.pipe(Layer.provide(EnvLive))
	const WarehouseQueryServiceLive = WarehouseQueryService.layer.pipe(
		Layer.provide(Layer.mergeAll(EnvLive, OrgClickHouseSettingsLive, TinybirdOrgTokenLive)),
	)
	return WarehouseQueryServiceLive.pipe(
		Layer.provideMerge(telemetry.layer),
		Layer.provideMerge(WorkerEnvironment.layer),
		Layer.provideMerge(WorkerConfigProviderLayer),
	)
}

export const flushAuditEventsTelemetry = (env: Record<string, unknown>) => telemetry.flush(env)

/**
 * Must match `maxRetries` on the audit-events consumer in `alchemy.run.ts`.
 * Cloudflare routes the message to the DLQ after this many retries without
 * telling us; the check below is what makes the hand-off visible in logs at
 * the moment it happens.
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

interface DecodedMessage {
	readonly message: Message<unknown>
	readonly event: AuditLogEvent
}

/**
 * Retrying past the limit is what hands the message to the DLQ; acking there
 * would silently discard it instead.
 */
const retryOrExhaust = (message: Message<unknown>, cause: unknown) => {
	const isFinalAttempt = message.attempts > AUDIT_EVENTS_MAX_RETRIES
	return Effect.annotateCurrentSpan({
		"audit.queue.message.outcome": isFinalAttempt ? "exhausted_dlq" : "retry",
	}).pipe(
		Effect.flatMap(() =>
			isFinalAttempt
				? Effect.logError("Audit event exhausted retries; routed to dead letter queue").pipe(
						Effect.annotateLogs({
							attempt: message.attempts,
							orgId: auditEventOrgId(message.body),
							action: auditEventAction(message.body),
							error: String(cause),
						}),
					)
				: Effect.logWarning("Audit event write failed; retrying").pipe(
						Effect.annotateLogs({ attempt: message.attempts, error: String(cause) }),
					),
		),
		Effect.flatMap(() => Effect.sync(() => message.retry())),
	)
}

/**
 * Audit events queue consumer: lowers each event to its `audit_log` row and
 * writes one batch per org through the managed ingest pipeline. The table is a
 * ReplacingMergeTree on the entry id, so queue redelivery collapses at merge
 * time; write failures retry through the queue's policy and, once exhausted,
 * land in `audit-events-dlq` rather than disappearing.
 */
export const processAuditEventsBatch = (batch: MessageBatch<unknown>) =>
	Effect.gen(function* () {
		const warehouse = yield* WarehouseQueryService
		const now = yield* Clock.currentTimeMillis

		const decoded: Array<DecodedMessage> = []
		for (const message of batch.messages) {
			const event = yield* decodeAuditLogEvent(message.body).pipe(
				Effect.matchEffect({
					// Undecodable now means undecodable on every redelivery, so retrying
					// only burns attempts. Acked, but at Error: an audit entry that
					// never reaches a row is lost evidence, not routine noise.
					onFailure: (error) =>
						Effect.logError("Discarding malformed audit event queue message").pipe(
							Effect.annotateLogs({ attempt: message.attempts, error: String(error) }),
							Effect.flatMap(() => Effect.sync(() => message.ack())),
							Effect.as(undefined),
						),
					onSuccess: (event) => Effect.succeed(event),
				}),
			)
			if (event !== undefined) decoded.push({ message, event })
		}

		// One `ingest` per org so the write span names the tenant it belongs to.
		const byOrg = new Map<OrgId, Array<DecodedMessage>>()
		for (const entry of decoded) {
			const group = byOrg.get(entry.event.orgId)
			if (group === undefined) byOrg.set(entry.event.orgId, [entry])
			else group.push(entry)
		}

		yield* Effect.forEach(
			byOrg,
			([orgId, group]) =>
				warehouse
					.ingest(
						systemTenant(orgId),
						AUDIT_LOG_DATASOURCE,
						group.map(({ event }) => auditEventToRow(event, now)),
					)
					.pipe(
						Effect.flatMap(() =>
							Effect.sync(() => {
								for (const { message } of group) message.ack()
							}),
						),
						Effect.withSpan("auditEvents.writeOrgBatch", { attributes: { orgId, rows: group.length } }),
						Effect.catchCause((cause) =>
							Effect.forEach(group, ({ message }) => retryOrExhaust(message, cause), {
								discard: true,
							}),
						),
					),
			{ concurrency: 3, discard: true },
		)
	}).pipe(Effect.withSpan("auditEvents.processBatch"))
