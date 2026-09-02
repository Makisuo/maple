import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import { ActorId, ApiKeyId, UserId } from "@maple/domain/primitives"
import {
	decodePublicId,
	encodePublicId,
	MapleApiV2,
	paginateOffsetQuery,
	PublicIdPrefixes,
	timestamp,
	V2InsufficientPermissions,
	V2ParameterInvalid,
} from "@maple/domain/http/v2"
import type { V2AuditLogEntry } from "@maple/domain/http/v2"
import type { AuditLogEntry } from "@/services/audit/audit-event"
import { Effect, Option, Schema } from "effect"
import { AuditLogService } from "@/services/audit/AuditLogService"
import { requireAdmin } from "@/services/auth/auth"
import type { AuditLogListFilters } from "@/services/audit/AuditLogService"

const adminOnly = () => V2InsufficientPermissions.make("Only org admins can read the audit log")

const decodeApiKeyIdOption = Schema.decodeUnknownOption(ApiKeyId)
const decodeActorIdOption = Schema.decodeUnknownOption(ActorId)
const decodeUserIdOption = Schema.decodeUnknownOption(UserId)

type ActorIdentityFilter = Pick<AuditLogListFilters, "userId" | "apiKeyId" | "actorId">

/**
 * Resolve the public `actor_id` filter to the column it identifies: `key_…` →
 * the API key, `actor_…` → the agent, anything else → a (Clerk-issued, already
 * public) user ID.
 */
const actorIdentityFilter = (publicActorId: string) => {
	const invalid = V2ParameterInvalid.make("Invalid actor_id.", { param: "actor_id" })
	const succeed = (filter: ActorIdentityFilter) => Effect.succeed(filter)
	const asApiKey = decodePublicId(PublicIdPrefixes.apiKey, publicActorId)
	if (asApiKey !== null) {
		return Option.match(decodeApiKeyIdOption(asApiKey), {
			onNone: () => Effect.fail(invalid),
			onSome: (apiKeyId) => succeed({ apiKeyId }),
		})
	}
	const asActor = decodePublicId(PublicIdPrefixes.actor, publicActorId)
	if (asActor !== null) {
		return Option.match(decodeActorIdOption(asActor), {
			onNone: () => Effect.fail(invalid),
			onSome: (actorId) => succeed({ actorId }),
		})
	}
	return Option.match(decodeUserIdOption(publicActorId), {
		onNone: () => Effect.fail(invalid),
		onSome: (userId) => succeed({ userId }),
	})
}

/** The actor's public identifier, matching the ID style of its own resource. */
const publicActorId = (row: AuditLogEntry): string | null => {
	switch (row.actorType) {
		case "api_key":
			return row.apiKeyId === null ? null : encodePublicId(PublicIdPrefixes.apiKey, row.apiKeyId)
		case "agent":
			return row.actorId === null ? null : encodePublicId(PublicIdPrefixes.actor, row.actorId)
		case "user":
			// Clerk user IDs are already prefixed public IDs — passed through as-is.
			return row.userId
		case "system":
			return null
	}
}

const toV2AuditLogEntry = (row: AuditLogEntry): V2AuditLogEntry => ({
	id: row.id,
	object: "audit_log_entry",
	action: row.action,
	outcome: row.outcome,
	denial_reason: row.denialReason,
	actor_type: row.actorType,
	actor_id: publicActorId(row),
	actor_name: row.actorLabel,
	affected_user: row.affectedUserId,
	source: row.source,
	resource_type: row.resourceType,
	resource_id: row.resourceId,
	changes: row.changes,
	metadata: row.metadata,
	request_id: row.requestId,
	origin_ip: row.originIp,
	origin_country: row.originCountry,
	occurred_at: timestamp(row.occurredAt.toISOString()),
	recorded_at: timestamp(row.recordedAt.toISOString()),
})

export const HttpV2AuditLogLive = HttpApiBuilder.group(MapleApiV2, "auditLog", (handlers) =>
	Effect.gen(function* () {
		const audit = yield* AuditLogService

		return handlers.handle("list", ({ query }) =>
			Effect.gen(function* () {
				const tenant = yield* CurrentTenant.Context
				// The log carries every member's activity, denial history, and origin
				// IP for the whole retention window — org admins only. Scoped API keys
				// are additionally gated by `audit_log:read`.
				yield* requireAdmin(tenant.roles, adminOnly)
				const identity =
					query.actor_id !== undefined ? yield* actorIdentityFilter(query.actor_id) : undefined
				const affectedUser =
					query.affected_user !== undefined
						? yield* Option.match(decodeUserIdOption(query.affected_user), {
								onNone: () =>
									Effect.fail(
										V2ParameterInvalid.make("Invalid affected_user.", { param: "affected_user" }),
									),
								onSome: (userId) => Effect.succeed(userId),
							})
						: undefined
				const page = yield* paginateOffsetQuery(query, ({ limit, offset }) =>
					audit
						.list(tenant.orgId, {
							...(query.actor_type !== undefined ? { actorType: query.actor_type } : undefined),
							...identity,
							...(affectedUser !== undefined ? { affectedUserId: affectedUser } : undefined),
							...(query.action !== undefined ? { action: query.action } : undefined),
							...(query.outcome !== undefined ? { outcome: query.outcome } : undefined),
							...(query.resource_type !== undefined
								? { resourceType: query.resource_type }
								: undefined),
							...(query.resource_id !== undefined
								? { resourceId: query.resource_id }
								: undefined),
							...(query.changed !== undefined ? { changedField: query.changed } : undefined),
							...(query.request_id !== undefined ? { requestId: query.request_id } : undefined),
							...(query.since !== undefined ? { sinceMs: Date.parse(query.since) } : undefined),
							...(query.until !== undefined ? { untilMs: Date.parse(query.until) } : undefined),
							limit,
							offset,
						})
						.pipe(Effect.map((rows) => rows.map(toV2AuditLogEntry))),
				)
				return { object: "list" as const, ...page }
			}),
		)
	}),
)
