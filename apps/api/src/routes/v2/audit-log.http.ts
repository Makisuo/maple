import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CurrentTenant } from "@maple/domain/http"
import { ActorId, ApiKeyId, OrgId, UserId } from "@maple/domain/primitives"
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
import { OrgMembersService } from "@/services/org/OrgMembersService"
import { requireAdmin } from "@/services/auth/auth"
import type { AuditLogListFilters } from "@/services/audit/AuditLogService"

const adminOnly = () => V2InsufficientPermissions.make("Only org admins can read the audit log")

/** No directory, no names — the entries still carry every id they were written with. */
const unnamed = (cause: unknown) =>
	Effect.logWarning("Audit log: member directory unavailable; entries keep their ids", {
		cause,
	}).pipe(Effect.as(new Map<string, ActorProfile>()))

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

/** What the workspace directory can tell us about one member. */
export interface ActorProfile {
	readonly name: string
	readonly imageUrl: string | null
}

/**
 * The name to show for one entry: the label frozen at write time when there is
 * one, else the current directory name — but only for a user actor, and only
 * ever their own.
 *
 * Every API-key and agent row also carries a `userId`, the person who minted
 * the credential. Naming those rows from the directory puts that person's name
 * on an action a key took, which is precisely the attribution an audit log
 * exists to keep straight. Entries written before keys carried their name show
 * an id, which is honest.
 */
export const actorDisplayName = (
	row: Pick<AuditLogEntry, "actorLabel" | "actorType" | "userId">,
	directory: ReadonlyMap<string, ActorProfile>,
): string | null =>
	row.actorLabel ??
	(row.actorType !== "user" || row.userId === null
		? null
		: (directory.get(row.userId)?.name ?? null))

/**
 * The avatar, for user actors only. An API key or an agent has no face, and a
 * departed member has no directory entry to take one from.
 */
export const actorAvatarUrl = (
	row: Pick<AuditLogEntry, "actorType" | "userId">,
	directory: ReadonlyMap<string, ActorProfile>,
): string | null =>
	row.actorType !== "user" || row.userId === null
		? null
		: (directory.get(row.userId)?.imageUrl ?? null)

/**
 * Name the humans. An API key freezes its name into `actorLabel` when the entry
 * is written, which is what an audit trail wants — the name the credential had
 * at the time. A dashboard session has nothing to freeze: Clerk's claims carry
 * no name, and resolving one per write would put a directory call on every
 * telemetry read. So user rows are labelled here, from the directory as it
 * stands, and an id that no longer belongs to a member simply keeps showing as
 * an id.
 */
const toV2AuditLogEntry = (
	row: AuditLogEntry,
	directory: ReadonlyMap<string, ActorProfile>,
): V2AuditLogEntry => ({
	id: row.id,
	object: "audit_log_entry",
	action: row.action,
	outcome: row.outcome,
	denial_reason: row.denialReason,
	actor_type: row.actorType,
	actor_id: publicActorId(row),
	actor_name: actorDisplayName(row, directory),
	actor_avatar_url: actorAvatarUrl(row, directory),
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
		const members = yield* OrgMembersService

		/**
		 * Names and avatars for the acting users, or nothing at all: a directory
		 * that is unconfigured (self-hosted without Clerk) or briefly unavailable
		 * must never turn reading the audit log into an error. Ids still render.
		 *
		 * A member with no name set falls back to their email, which is what the
		 * rest of the product shows and what an admin reading an audit trail
		 * actually recognises — an opaque `user_…` is the last resort, not the
		 * second one.
		 *
		 * `catch` + `catchDefect` rather than `catchCause`, which would also
		 * swallow the interrupt that tears this request down.
		 */
		const directory = (orgId: OrgId) =>
			members.listMembers(orgId).pipe(
				Effect.map(
					(all) =>
						new Map(
							all.map(
								(member) =>
									[
										member.userId,
										{ name: member.name ?? member.email, imageUrl: member.imageUrl },
									] as const,
							),
						),
				),
				Effect.catch((error) => unnamed(error)),
				Effect.catchDefect((defect) => unnamed(defect)),
			)

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
						.pipe(
							Effect.flatMap((rows) =>
								rows.length === 0
									? Effect.succeed([])
									: directory(tenant.orgId).pipe(
											Effect.map((known) =>
												rows.map((row) => toV2AuditLogEntry(row, known)),
											),
										),
							),
						),
				)
				return { object: "list" as const, ...page }
			}),
		)
	}),
)
