import { randomUUID } from "node:crypto"
import { HttpServerRequest } from "effect/unstable/http"
import { AuditLogPersistenceError, CurrentTenant } from "@maple/domain/http"
import type { AuditActorType, AuditChanges, AuditLogSource, AuditOutcome } from "@maple/domain/http"
import type { ActorId, ApiKeyId, OrgId, UserId } from "@maple/domain/primitives"
import { AuditLogEntryId as AuditLogEntryIdSchema } from "@maple/domain/primitives"
import * as CH from "@maple/query-engine/ch"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import type { Queue } from "@cloudflare/workers-types"
import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { msToWarehouseDateTime64 } from "@/platform/time"
import { systemTenant } from "@/services/alerts/system-tenant"
import { CurrentAuditActor } from "@/services/auth/audit-actor"
import { WarehouseQueryService } from "@/services/warehouse/WarehouseQueryService"
import { type AuditAction, auditResourceFields, type AuditResourceIdOption } from "./audit-actions"
import {
	AuditLogEvent,
	type AuditLogEntry,
	auditEventToEntry,
	auditEventToRow,
	decodeStoredAuditLogEntry,
	encodeAuditLogEventSync,
	storedRowToEntry,
} from "./audit-event"

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

/** The warehouse datasource every audit entry lands in. */
export const AUDIT_LOG_DATASOURCE = "audit_log"

/**
 * `queue.send` sits on the response path of every mutation, denial, and
 * audited read. A healthy send is tens of ms; 2s bounds a stalling broker
 * before the entry degrades to a direct warehouse write.
 */
export const AUDIT_QUEUE_SEND_TIMEOUT = "2 seconds"

const toPersistenceError = (error: { readonly _tag: string; readonly message?: string }) =>
	new AuditLogPersistenceError({ message: error.message ?? error._tag, cause: error })

/** The credential-holder behind an audited action, as known at the call site. */
export interface AuditActorRef {
	readonly type: AuditActorType
	readonly userId?: UserId
	readonly apiKeyId?: ApiKeyId
	readonly actorId?: ActorId
	readonly label?: string
}

export type AuditLogRecordInput<A extends AuditAction = AuditAction> = {
	readonly orgId: OrgId
	readonly actor: AuditActorRef
	readonly source: AuditLogSource
	/** Declared in `AuditResources`; the row's `resource_type` is derived from it. */
	readonly action: A
	/** Defaults to `"allowed"`; denied attempts pass `"denied"` + `denialReason`. */
	readonly outcome?: AuditOutcome
	readonly denialReason?: string
	readonly affectedUserId?: UserId
	readonly changes?: AuditChanges | undefined
	readonly metadata?: Record<string, unknown>
	readonly requestId?: string
	readonly originIp?: string
	readonly originCountry?: string
} & AuditResourceIdOption<A>

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
	 * binding is present (the consumer performs the warehouse write, retried by
	 * the queue), written straight to the warehouse otherwise (local dev, crons).
	 * Never fails: an action that succeeded must not 500 because its audit
	 * write did not — terminal failures are logged and swallowed.
	 */
	readonly record: <A extends AuditAction>(input: AuditLogRecordInput<A>) => Effect.Effect<void>
	readonly list: (
		orgId: OrgId,
		filters: AuditLogListFilters,
	) => Effect.Effect<ReadonlyArray<AuditLogEntry>, AuditLogPersistenceError>
}

/** Build the queue event for one `record` call, stamping id and `occurredAt`. */
const makeEvent = <A extends AuditAction>(input: AuditLogRecordInput<A>, nowMs: number) => {
	const resource = auditResourceFields(input.action, input.resourceId)
	return new AuditLogEvent({
		orgId: input.orgId,
		id: decodeAuditLogEntryIdSync(randomUUID()),
		actorType: input.actor.type,
		...(input.actor.userId !== undefined ? { userId: input.actor.userId } : undefined),
		...(input.actor.apiKeyId !== undefined ? { apiKeyId: input.actor.apiKeyId } : undefined),
		...(input.actor.actorId !== undefined ? { actorId: input.actor.actorId } : undefined),
		...(input.actor.label !== undefined ? { actorLabel: input.actor.label } : undefined),
		...(input.affectedUserId !== undefined ? { affectedUserId: input.affectedUserId } : undefined),
		source: input.source,
		action: input.action,
		outcome: input.outcome ?? "allowed",
		...(input.denialReason !== undefined ? { denialReason: input.denialReason } : undefined),
		resourceType: resource.resourceType,
		...(resource.resourceId !== undefined ? { resourceId: resource.resourceId } : undefined),
		...(input.changes !== undefined ? { changes: input.changes } : undefined),
		...(input.metadata !== undefined ? { metadata: input.metadata } : undefined),
		...(input.requestId !== undefined ? { requestId: input.requestId } : undefined),
		...(input.originIp !== undefined ? { originIp: input.originIp } : undefined),
		...(input.originCountry !== undefined ? { originCountry: input.originCountry } : undefined),
		occurredAtMs: nowMs,
	})
}

/** Self-observability: refused attempts are the entries worth alerting on. */
const logDenied = (event: AuditLogEvent) =>
	event.outcome === "denied"
		? Effect.logWarning("Audit: denied action").pipe(
				Effect.annotateLogs({
					orgId: event.orgId,
					action: event.action,
					actorType: event.actorType,
					denialReason: event.denialReason ?? "",
				}),
			)
		: Effect.void

/**
 * `record` never fails: swallow typed failures and defects — an action that
 * succeeded must not 500 because its audit write did not — but let interrupts
 * propagate so fiber teardown never triggers a stray write.
 */
const neverFail = (action: string) => (write: Effect.Effect<void, unknown>) =>
	write.pipe(
		Effect.catch((error) => Effect.logWarning("Audit log write failed", { action, cause: error })),
		Effect.catchDefect((defect) => Effect.logWarning("Audit log write failed", { action, cause: defect })),
	)

/** Which optional filters bind, and the parameter values behind them. */
const listQueryInputs = (orgId: OrgId, filters: AuditLogListFilters) => {
	const since = filters.sinceMs === undefined ? undefined : msToWarehouseDateTime64(filters.sinceMs)
	const until = filters.untilMs === undefined ? undefined : msToWarehouseDateTime64(filters.untilMs)
	const opts: CH.AuditLogEntriesOpts = {
		actorType: filters.actorType !== undefined,
		userId: filters.userId !== undefined,
		apiKeyId: filters.apiKeyId !== undefined,
		actorId: filters.actorId !== undefined,
		affectedUserId: filters.affectedUserId !== undefined,
		action: filters.action !== undefined,
		outcome: filters.outcome !== undefined,
		resourceType: filters.resourceType !== undefined,
		resourceId: filters.resourceId !== undefined,
		changedField: filters.changedField !== undefined,
		requestId: filters.requestId !== undefined,
		since: since !== undefined,
		until: until !== undefined,
		limit: filters.limit,
		offset: filters.offset,
	}
	const values = {
		orgId,
		...(filters.actorType !== undefined ? { actorType: filters.actorType } : undefined),
		...(filters.userId !== undefined ? { userId: filters.userId } : undefined),
		...(filters.apiKeyId !== undefined ? { apiKeyId: filters.apiKeyId } : undefined),
		...(filters.actorId !== undefined ? { actorId: filters.actorId } : undefined),
		...(filters.affectedUserId !== undefined ? { affectedUserId: filters.affectedUserId } : undefined),
		...(filters.action !== undefined ? { action: filters.action } : undefined),
		...(filters.outcome !== undefined ? { outcome: filters.outcome } : undefined),
		...(filters.resourceType !== undefined ? { resourceType: filters.resourceType } : undefined),
		...(filters.resourceId !== undefined ? { resourceId: filters.resourceId } : undefined),
		...(filters.changedField !== undefined ? { changedField: filters.changedField } : undefined),
		...(filters.requestId !== undefined ? { requestId: filters.requestId } : undefined),
		...(since !== undefined ? { since } : undefined),
		...(until !== undefined ? { until } : undefined),
	}
	return { opts, values }
}

export class AuditLogService extends Context.Service<AuditLogService, AuditLogServiceApi>()(
	"@maple/api/services/AuditLogService",
	{
		make: Effect.gen(function* () {
			const warehouse = yield* WarehouseQueryService
			// Optional so tests and non-Worker runtimes fall back to direct writes
			// without providing a WorkerEnvironment.
			const workerEnv = yield* Effect.serviceOption(WorkerEnvironment)
			const queue = Option.match(workerEnv, {
				onNone: () => undefined,
				onSome: (env) => {
					const binding = env[AUDIT_EVENTS_QUEUE_BINDING]
					// SAFETY: the binding slot is owned by this service; anything present is the queue.
					return binding === undefined ? undefined : (binding as Queue<unknown>)
				},
			})

			// One row through the managed ingest pipeline. `ingest` is pinned to
			// Tinybird regardless of the org's read backend, which is the point:
			// the audit log is Maple's record and never lands in a BYO warehouse.
			const writeDirect = (event: AuditLogEvent) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					yield* warehouse.ingest(systemTenant(event.orgId), AUDIT_LOG_DATASOURCE, [
						auditEventToRow(event, now),
					])
				})

			// Queue unavailability must not lose the entry: degrade to a direct
			// write before giving up. Only typed send failures land here — an
			// interrupt must propagate, not spawn a warehouse write mid-teardown.
			const fallbackToDirect = (event: AuditLogEvent, error: AuditQueueSendError) =>
				Effect.logWarning("Audit queue send failed; writing directly", { cause: error }).pipe(
					Effect.andThen(writeDirect(event)),
				)

			const publish = (event: AuditLogEvent) =>
				queue === undefined
					? writeDirect(event)
					: Effect.tryPromise({
							try: () => queue.send(encodeAuditLogEventSync(event)),
							catch: (cause) =>
								new AuditQueueSendError({ message: "Audit queue send failed", cause }),
						}).pipe(
							// A Queues brown-out that stalls (rather than rejects) must not
							// hang the response: 2s is far above a healthy send's latency
							// yet bounds the worst case before the direct-write fallback.
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
				const event = makeEvent(input, now)
				yield* logDenied(event)
				yield* publish(event).pipe(neverFail(input.action))
			})

			const list: AuditLogServiceApi["list"] = Effect.fn("AuditLogService.list")(function* (
				orgId,
				filters,
			) {
				const { opts, values } = listQueryInputs(orgId, filters)
				const rows = yield* warehouse
					.compiledQuery(
						systemTenant(orgId),
						CH.compile(CH.auditLogEntriesQuery(opts), values),
						{ profile: "list", context: "auditLog.list" },
					)
					.pipe(Effect.mapError(toPersistenceError))
				const entries = yield* Effect.forEach(rows, (row) =>
					decodeStoredAuditLogEntry(row).pipe(
						Effect.map((decoded) => storedRowToEntry(orgId, decoded)),
						Effect.mapError((error) =>
							new AuditLogPersistenceError({
								message: "Stored audit entry failed to decode",
								cause: error,
							}),
						),
					),
				)
				// A redelivered event the ReplacingMergeTree has not merged yet is
				// the same entry twice; one copy is enough.
				const seen = new Set<string>()
				return entries.filter((entry) => !seen.has(entry.id) && seen.add(entry.id) !== undefined)
			})

			return { record, list }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)

	/**
	 * Entries kept in process memory, with the same filter and ordering
	 * semantics as the warehouse query. For tests and anything else that must
	 * not reach a warehouse.
	 */
	static readonly layerMemory = Layer.sync(this, makeMemoryAuditLog)
}

/** The in-memory implementation behind `AuditLogService.layerMemory`; usable directly in a `Context`. */
export function makeMemoryAuditLog(): AuditLogServiceApi {
	const entries: Array<AuditLogEntry> = []
	const record: AuditLogServiceApi["record"] = (input) =>
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const event = makeEvent(input, now)
			yield* logDenied(event)
			entries.push(auditEventToEntry(event, now))
		})
	const list: AuditLogServiceApi["list"] = (orgId, filters) =>
		Effect.succeed(
			entries
				.filter(
					(entry) =>
						entry.orgId === orgId &&
						(filters.actorType === undefined || entry.actorType === filters.actorType) &&
						(filters.userId === undefined || entry.userId === filters.userId) &&
						(filters.apiKeyId === undefined || entry.apiKeyId === filters.apiKeyId) &&
						(filters.actorId === undefined || entry.actorId === filters.actorId) &&
						(filters.affectedUserId === undefined ||
							entry.affectedUserId === filters.affectedUserId) &&
						(filters.action === undefined || entry.action === filters.action) &&
						(filters.outcome === undefined || entry.outcome === filters.outcome) &&
						(filters.resourceType === undefined || entry.resourceType === filters.resourceType) &&
						(filters.resourceId === undefined || entry.resourceId === filters.resourceId) &&
						(filters.changedField === undefined ||
							(entry.changedFields?.includes(filters.changedField) ?? false)) &&
						(filters.requestId === undefined || entry.requestId === filters.requestId) &&
						(filters.sinceMs === undefined || entry.occurredAt.getTime() >= filters.sinceMs) &&
						(filters.untilMs === undefined || entry.occurredAt.getTime() <= filters.untilMs),
				)
				.sort(
					(a, b) =>
						b.occurredAt.getTime() - a.occurredAt.getTime() || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0),
				)
				.slice(filters.offset, filters.offset + filters.limit),
		)
	return { record, list }
}

/** Request forensics for an audit entry, read off the Cloudflare request headers. */
export const httpRequestForensics = (request: HttpServerRequest.HttpServerRequest) => ({
	...(request.headers["cf-ray"] !== undefined ? { requestId: request.headers["cf-ray"] } : undefined),
	...(request.headers["cf-connecting-ip"] !== undefined
		? { originIp: request.headers["cf-connecting-ip"] }
		: undefined),
	...(request.headers["cf-ipcountry"] !== undefined
		? { originCountry: request.headers["cf-ipcountry"] }
		: undefined),
})

/** Forensics for the current request, or nothing outside an HTTP request. */
export const currentRequestForensics = Effect.gen(function* () {
	const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
	return Option.match(request, {
		onNone: () => ({}),
		onSome: httpRequestForensics,
	})
})

/**
 * Record an audit entry for the current authenticated HTTP request, deriving
 * the actor and surface from the tenant plus the auth middleware's
 * `CurrentAuditActor`, and request forensics (request id, origin) from the
 * Cloudflare headers. The credential kind and the surface both come from the
 * reference — an API-key or MCP request must not read back as a dashboard
 * session.
 */
export const recordHttpAudit = <A extends AuditAction>(
	action: A,
	opts?: {
		readonly changes?: AuditChanges | undefined
		readonly affectedUserId?: UserId
		readonly metadata?: Record<string, unknown>
	} & AuditResourceIdOption<A>,
) =>
	Effect.gen(function* () {
		const audit = yield* AuditLogService
		const tenant = yield* CurrentTenant.Context
		const info = yield* CurrentAuditActor
		const context = yield* currentRequestForensics
		// No reference means the request bypassed every auth middleware (internal
		// tokens, tests). Attribute to the tenant's user rather than inventing a
		// credential, but do not claim a surface the request may not have used.
		yield* audit.record({
			orgId: tenant.orgId,
			actor: {
				type: info?.type ?? "user",
				userId: tenant.userId,
				...(info?.apiKeyId !== undefined ? { apiKeyId: info.apiKeyId } : undefined),
			},
			source: info?.source ?? "dashboard",
			action,
			...context,
			...opts,
		})
	})
