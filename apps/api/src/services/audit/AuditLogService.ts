import { randomUUID } from "node:crypto"
import { HttpServerRequest } from "effect/unstable/http"
import { AuditLogPersistenceError, CurrentTenant } from "@maple/domain/http"
import type { AuditActorType, AuditChanges, AuditLogSource, AuditOutcome } from "@maple/domain/http"
import type { ActorId, ApiKeyId, OrgId, UserId } from "@maple/domain/primitives"
import { AuditLogEntryId as AuditLogEntryIdSchema } from "@maple/domain/primitives"
import { auditLogEntries, type AuditLogEntryRow } from "@maple/db"
import { and, arrayContains, desc, eq, gte, lte } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import type { Queue } from "@cloudflare/workers-types"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Database, type DatabaseError } from "@/platform/DatabaseLive"
import { msToDate } from "@/platform/time"
import { CurrentAuditActor } from "@/services/auth/audit-actor"
import { AuditLogEvent, auditEventToInsert, encodeAuditLogEventSync } from "./audit-event"

const decodeAuditLogEntryIdSync = Schema.decodeUnknownSync(AuditLogEntryIdSchema)

class AuditQueueSendError extends Schema.TaggedError<AuditQueueSendError>()(
	"@maple/api/services/audit/AuditQueueSendError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** Producer binding name; the paired `*_NAME` var drives consumer dispatch. */
export const AUDIT_EVENTS_QUEUE_BINDING = "AUDIT_EVENTS_QUEUE"

/**
 * `queue.send` sits on the response path of every mutation and denial. A
 * healthy send is tens of ms; 2s bounds a stalling broker before the entry
 * degrades to a direct Postgres write.
 */
export const AUDIT_QUEUE_SEND_TIMEOUT = "2 seconds"

const toPersistenceError = (error: DatabaseError) =>
	new AuditLogPersistenceError({ message: error.message, cause: error })

/** The credential-holder behind an audited action, as known at the call site. */
export interface AuditActorRef {
	readonly type: AuditActorType
	readonly userId?: UserId
	readonly apiKeyId?: ApiKeyId
	readonly actorId?: ActorId
	readonly label?: string
}

export interface AuditLogRecordInput {
	readonly orgId: OrgId
	readonly actor: AuditActorRef
	readonly source: AuditLogSource
	/** `<resource>.<verb>`, e.g. `alert_rule.created`. */
	readonly action: string
	/** Defaults to `"allowed"`; denied attempts pass `"denied"` + `denialReason`. */
	readonly outcome?: AuditOutcome
	readonly denialReason?: string
	readonly affectedUserId?: UserId
	readonly resourceType?: string
	readonly resourceId?: string
	readonly changes?: AuditChanges
	readonly metadata?: Record<string, unknown>
	readonly requestId?: string
	readonly originIp?: string
	readonly originCountry?: string
}

export interface AuditLogListFilters {
	readonly actorType?: AuditActorType
	/** At most one of the three actor-identity filters is set per request. */
	readonly userId?: UserId
	readonly apiKeyId?: ApiKeyId
	readonly actorId?: ActorId
	readonly affectedUserId?: UserId
	readonly action?: string
	readonly outcome?: AuditOutcome
	readonly resourceType?: string
	/** Matches the stored public form (e.g. `dash_…`). */
	readonly resourceId?: string
	/** Field name that an update's diff must have touched. */
	readonly changedField?: string
	readonly requestId?: string
	readonly sinceMs?: number
	readonly untilMs?: number
	readonly limit: number
	readonly offset: number
}

export interface AuditLogServiceApi {
	/**
	 * Append one entry, durably: published to the audit events queue when the
	 * binding is present (the consumer performs the insert, retried by the
	 * queue), written straight to Postgres otherwise (tests, local dev, crons).
	 * Never fails: a mutation that succeeded must not 500 because its audit
	 * write did not — terminal failures are logged and swallowed.
	 */
	readonly record: (input: AuditLogRecordInput) => Effect.Effect<void>
	readonly list: (
		orgId: OrgId,
		filters: AuditLogListFilters,
	) => Effect.Effect<ReadonlyArray<AuditLogEntryRow>, AuditLogPersistenceError>
}

export class AuditLogService extends Context.Service<AuditLogService, AuditLogServiceApi>()(
	"@maple/api/services/AuditLogService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			// Optional so PGlite tests and non-Worker runtimes fall back to direct
			// writes without providing a WorkerEnvironment.
			const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)
			const queue = Option.match(workerEnv, {
				onNone: () => undefined,
				onSome: (env) => {
					const binding = env[AUDIT_EVENTS_QUEUE_BINDING]
					// SAFETY: the binding slot is owned by this service; anything present is the queue.
					return binding === undefined ? undefined : (binding as Queue<unknown>)
				},
			})

			const insertDirect = (event: AuditLogEvent) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					yield* database.execute((db) =>
						db.insert(auditLogEntries).values(auditEventToInsert(event, now)).onConflictDoNothing(),
					)
				})

			// Queue unavailability must not lose the entry: degrade to a direct
			// write before giving up. Only typed send failures land here — an
			// interrupt must propagate, not spawn a Postgres insert mid-teardown.
			const fallbackToDirect = (event: AuditLogEvent, error: AuditQueueSendError) =>
				Effect.logWarning("Audit queue send failed; writing directly", { cause: error }).pipe(
					Effect.andThen(insertDirect(event)),
				)

			const publish = (event: AuditLogEvent) =>
				queue === undefined
					? insertDirect(event)
					: Effect.tryPromise({
							try: () => queue.send(encodeAuditLogEventSync(event)),
							catch: (cause) =>
								new AuditQueueSendError({ message: "Audit queue send failed", cause }),
						}).pipe(
							// A Queues brown-out that stalls (rather than rejects) must not
							// hang the mutation's response: 2s is far above a healthy send's
							// latency yet bounds the worst case before the direct-write fallback.
							Effect.timeout(AUDIT_QUEUE_SEND_TIMEOUT),
							Effect.catchTag("TimeoutError", (error) =>
								Effect.fail(new AuditQueueSendError({ message: "Audit queue send timed out", cause: error })),
							),
							Effect.catchTag("@maple/api/services/audit/AuditQueueSendError", (error) =>
								fallbackToDirect(event, error),
							),
						)

			const record: AuditLogServiceApi["record"] = Effect.fn("AuditLogService.record")(function* (
				input,
			) {
				const now = yield* Clock.currentTimeMillis
				const event = new AuditLogEvent({
					orgId: input.orgId,
					id: decodeAuditLogEntryIdSync(randomUUID()),
					actorType: input.actor.type,
					...(input.actor.userId !== undefined ? { userId: input.actor.userId } : undefined),
					...(input.actor.apiKeyId !== undefined ? { apiKeyId: input.actor.apiKeyId } : undefined),
					...(input.actor.actorId !== undefined ? { actorId: input.actor.actorId } : undefined),
					...(input.actor.label !== undefined ? { actorLabel: input.actor.label } : undefined),
					...(input.affectedUserId !== undefined
						? { affectedUserId: input.affectedUserId }
						: undefined),
					source: input.source,
					action: input.action,
					outcome: input.outcome ?? "allowed",
					...(input.denialReason !== undefined ? { denialReason: input.denialReason } : undefined),
					...(input.resourceType !== undefined ? { resourceType: input.resourceType } : undefined),
					...(input.resourceId !== undefined ? { resourceId: input.resourceId } : undefined),
					...(input.changes !== undefined ? { changes: input.changes } : undefined),
					...(input.metadata !== undefined ? { metadata: input.metadata } : undefined),
					...(input.requestId !== undefined ? { requestId: input.requestId } : undefined),
					...(input.originIp !== undefined ? { originIp: input.originIp } : undefined),
					...(input.originCountry !== undefined
						? { originCountry: input.originCountry }
						: undefined),
					occurredAtMs: now,
				})
				// High-signal by definition — surfaced as a warning so Maple's own
				// error/log alerting can watch for spikes of refused attempts.
				if (event.outcome === "denied") {
					yield* Effect.logWarning("Audit: denied action").pipe(
						Effect.annotateLogs({
							orgId: event.orgId,
							action: event.action,
							actorType: event.actorType,
							denialReason: event.denialReason ?? "",
						}),
					)
				}
				// Swallow typed failures and defects — a mutation that succeeded must
				// not 500 because its audit write did not — but let interrupts
				// propagate so fiber teardown never triggers a stray insert.
				yield* publish(event).pipe(
					Effect.catch((error) =>
						Effect.logWarning("Audit log write failed", { action: input.action, cause: error }),
					),
					Effect.catchDefect((defect) =>
						Effect.logWarning("Audit log write failed", { action: input.action, cause: defect }),
					),
				)
			})

			const list: AuditLogServiceApi["list"] = Effect.fn("AuditLogService.list")(function* (
				orgId,
				filters,
			) {
				const conditions = [
					eq(auditLogEntries.orgId, orgId),
					...(filters.actorType !== undefined
						? [eq(auditLogEntries.actorType, filters.actorType)]
						: []),
					...(filters.userId !== undefined ? [eq(auditLogEntries.userId, filters.userId)] : []),
					...(filters.apiKeyId !== undefined
						? [eq(auditLogEntries.apiKeyId, filters.apiKeyId)]
						: []),
					...(filters.actorId !== undefined ? [eq(auditLogEntries.actorId, filters.actorId)] : []),
					...(filters.affectedUserId !== undefined
						? [eq(auditLogEntries.affectedUserId, filters.affectedUserId)]
						: []),
					...(filters.action !== undefined ? [eq(auditLogEntries.action, filters.action)] : []),
					...(filters.outcome !== undefined ? [eq(auditLogEntries.outcome, filters.outcome)] : []),
					...(filters.resourceType !== undefined
						? [eq(auditLogEntries.resourceType, filters.resourceType)]
						: []),
					...(filters.resourceId !== undefined
						? [eq(auditLogEntries.resourceId, filters.resourceId)]
						: []),
					...(filters.changedField !== undefined
						? [arrayContains(auditLogEntries.changedFields, [filters.changedField])]
						: []),
					...(filters.requestId !== undefined
						? [eq(auditLogEntries.requestId, filters.requestId)]
						: []),
					...(filters.sinceMs !== undefined
						? [gte(auditLogEntries.occurredAt, msToDate(filters.sinceMs))]
						: []),
					...(filters.untilMs !== undefined
						? [lte(auditLogEntries.occurredAt, msToDate(filters.untilMs))]
						: []),
				]
				return yield* database
					.execute((db) =>
						db
							.select()
							.from(auditLogEntries)
							.where(and(...conditions))
							.orderBy(desc(auditLogEntries.occurredAt), desc(auditLogEntries.id))
							.limit(filters.limit)
							.offset(filters.offset),
					)
					.pipe(Effect.mapError(toPersistenceError))
			})

			return { record, list }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}

/** Request forensics for an audit entry, read off the Cloudflare request headers. */
const requestContext = Effect.gen(function* () {
	const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
	return Option.match(request, {
		onNone: () => ({}),
		onSome: (req) => ({
			...(req.headers["cf-ray"] !== undefined ? { requestId: req.headers["cf-ray"] } : undefined),
			...(req.headers["cf-connecting-ip"] !== undefined
				? { originIp: req.headers["cf-connecting-ip"] }
				: undefined),
			...(req.headers["cf-ipcountry"] !== undefined
				? { originCountry: req.headers["cf-ipcountry"] }
				: undefined),
		}),
	})
})

/**
 * Record an audit entry for the current authenticated HTTP request, deriving
 * the actor from the tenant plus the auth middleware's `CurrentAuditActor`,
 * and request forensics (request id, origin) from the Cloudflare headers.
 * Session requests (and requests that bypassed the standard middlewares)
 * attribute to the user; API-key requests attribute to the key.
 */
export const recordHttpAudit = (
	action: string,
	opts?: {
		readonly resourceType?: string
		readonly resourceId?: string
		readonly changes?: AuditChanges
		readonly affectedUserId?: UserId
		readonly metadata?: Record<string, unknown>
	},
) =>
	Effect.gen(function* () {
		const audit = yield* AuditLogService
		const tenant = yield* CurrentTenant.Context
		const info = yield* CurrentAuditActor
		const context = yield* requestContext
		const isApiKey = info?.type === "api_key"
		yield* audit.record({
			orgId: tenant.orgId,
			actor: {
				type: isApiKey ? "api_key" : "user",
				userId: tenant.userId,
				...(isApiKey && info.apiKeyId !== undefined ? { apiKeyId: info.apiKeyId } : undefined),
			},
			source: isApiKey ? "api" : "dashboard",
			action,
			...context,
			...opts,
		})
	})
