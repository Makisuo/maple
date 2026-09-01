import { EdgeCacheService } from "@maple/cache"
import {
	alertDestinations,
	apiKeys,
	cliDeviceAuthorizations,
	mcpOAuthAuthorizations,
	mobileDevices,
} from "@maple/db"
import { RoleName, type OrgId, type UserId } from "@maple/domain/http"
import { and, eq, inArray } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Redacted, Schema } from "effect"
import { Database } from "@/platform/DatabaseLive"
import { Env } from "@/platform/Env"
import { makeDbExecute } from "@/platform/db-execute"
import { msToDate } from "@/platform/time"
import {
	DestinationPublicConfigSchema,
	SecretConfigFromJson,
} from "@/services/alerts/AlertDestinationHydration"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "@/platform/Crypto"
import { ORG_MEMBERSHIP_CACHE_BUCKET, forgetMembershipMemo } from "./OrgMembershipService"
import { isAdmin } from "./auth"
import { revokeFamiliesForAccessKeys, revokeRefreshFamiliesForMember } from "./mcp-oauth-family"

/**
 * What has to happen the moment somebody stops being a member of an org.
 *
 * Nothing ran on removal before this existed, and five separate authorization
 * findings were all the same absence: the membership cache kept answering yes
 * for five minutes, and every *user-bound* credential minted for that person —
 * CLI keys, MCP grants, alert emails, push devices — never re-checked
 * membership at all, so the five-minute window was really "forever".
 *
 * Every step is idempotent and predicate-driven, so a webhook retry converges
 * rather than double-applying.
 */

export class MembershipRevocationError extends Schema.TaggedError<MembershipRevocationError>()(
	"@maple/api/errors/MembershipRevocationError",
	{
		message: Schema.String,
		orgId: Schema.optionalKey(Schema.String),
		userId: Schema.optionalKey(Schema.String),
		cause: Schema.optionalKey(Schema.String),
	},
) {}

export interface MembershipRevocationSummary {
	readonly apiKeysRevoked: number
	readonly mcpFamiliesRevoked: number
	readonly cliAuthorizationsDeleted: number
	readonly mcpAuthorizationsDeleted: number
	readonly emailDestinationsUpdated: number
	readonly mobileDevicesDeleted: number
}

export interface MembershipDemotionSummary {
	readonly apiKeysRevoked: number
	readonly mcpFamiliesRevoked: number
}

export interface MembershipRevocationServiceApi {
	/**
	 * Evict the membership caches and retire everything that person held in the
	 * org. Cache eviction runs first and never fails — it closes the widest
	 * window even when the database work later errors and the delivery retries.
	 */
	readonly revokeMembership: (
		orgId: OrgId,
		userId: UserId,
	) => Effect.Effect<MembershipRevocationSummary, MembershipRevocationError>
	/**
	 * The same sweep with no org filter, for `user.deleted`: Clerk's payload
	 * names no organizations and the memberships are already gone by the time it
	 * arrives, so the credential tables are the only remaining record of where
	 * that person had access.
	 */
	readonly revokeUser: (
		userId: UserId,
	) => Effect.Effect<MembershipRevocationSummary, MembershipRevocationError>
	/**
	 * `organizationMembership.updated`: evict the caches, and retire the keys the
	 * member's *old* role is still pinned onto. `roles` is the role set the
	 * member has now — a promotion strips nothing.
	 */
	readonly demoteMembership: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<MembershipDemotionSummary, MembershipRevocationError>
	/** Evict the membership caches only — the one step that never fails. */
	readonly invalidateMembership: (userId: UserId) => Effect.Effect<void>
}

const toRevocationError = (error: unknown) =>
	new MembershipRevocationError({
		message: error instanceof Error ? error.message : "Membership revocation failed",
	})

/**
 * The shape every role-bearing key metadata shares (`maple_cli`, `maple_mcp`,
 * `maple_mcp_oauth`, `maple_ios_widget`): the minting user's roles, frozen onto
 * the key. `resolveByKey` reads them back with no membership recheck, which is
 * why a demotion has to come and take them away.
 */
const PinnedRoles = Schema.Struct({ roles: Schema.Array(RoleName) })
const decodePinnedRoles = Schema.decodeUnknownOption(PinnedRoles)

const decodePublicConfig = Schema.decodeUnknownOption(DestinationPublicConfigSchema)
const decodeSecretConfig = Schema.decodeOption(SecretConfigFromJson)

const make = Effect.gen(function* () {
	const database = yield* Database
	const env = yield* Env
	const edgeCache = yield* EdgeCacheService
	const dbExecute = makeDbExecute(database, "MembershipRevocationService", toRevocationError)

	const encryptionKey = yield* parseBase64Aes256GcmKey(
		Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
		(message) => new MembershipRevocationError({ message }),
	)

	const invalidateMembership = Effect.fn("MembershipRevocationService.invalidateMembership")(function* (
		userId: UserId,
	) {
		yield* Effect.annotateCurrentSpan({ "tenant.userId": userId })
		forgetMembershipMemo(userId)
		yield* edgeCache.invalidate({ bucket: ORG_MEMBERSHIP_CACHE_BUCKET, key: userId })
	})

	/**
	 * Email destinations store a snapshot of resolved member addresses inside
	 * the encrypted secret config, so a removed member keeps receiving alerts
	 * until somebody re-saves the destination by hand. Rewrite both halves of
	 * the config with that member dropped.
	 *
	 * A destination left with zero members is disabled rather than deleted: the
	 * rules pointing at it stay valid, and an admin sees why it went quiet.
	 */
	const stripFromEmailDestinations = Effect.fn("MembershipRevocationService.stripFromEmailDestinations")(
		function* (orgId: OrgId | null, userId: UserId) {
			const rows = yield* dbExecute((db) =>
				db
					.select()
					.from(alertDestinations)
					.where(
						orgId === null
							? eq(alertDestinations.type, "email")
							: and(eq(alertDestinations.orgId, orgId), eq(alertDestinations.type, "email")),
					),
			)
			let updated = 0
			for (const row of rows) {
				const secretJson = yield* decryptAes256Gcm(
					{ ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag },
					encryptionKey,
					() =>
						new MembershipRevocationError({
							message: `Could not decrypt alert destination ${row.id}`,
							...(orgId === null ? undefined : { orgId }),
						}),
				)
				const secret = decodeSecretConfig(secretJson)
				if (secret._tag === "None" || secret.value.type !== "email") continue
				const remaining = secret.value.members.filter((member) => member.userId !== userId)
				if (remaining.length === secret.value.members.length) continue

				const nextSecret = { type: "email" as const, members: remaining }
				const encrypted = yield* encryptAes256Gcm(
					JSON.stringify(nextSecret),
					encryptionKey,
					(message) =>
						new MembershipRevocationError({
							message,
							...(orgId === null ? undefined : { orgId }),
						}),
				)
				const publicConfig = decodePublicConfig(row.configJson)
				const first = remaining[0]
				const nextPublic = {
					...(publicConfig._tag === "Some" ? publicConfig.value : { channelLabel: null }),
					summary:
						first === undefined
							? "Email"
							: remaining.length === 1
								? (first.name ?? first.email)
								: `${first.name ?? first.email} +${remaining.length - 1} more`,
					channelLabel: first?.email ?? null,
					memberUserIds: remaining.map((member) => member.userId),
				}
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db
						.update(alertDestinations)
						.set({
							configJson: nextPublic,
							secretCiphertext: encrypted.ciphertext,
							secretIv: encrypted.iv,
							secretTag: encrypted.tag,
							updatedAt: msToDate(now),
							...(remaining.length === 0
								? {
										enabled: false,
										disabledAt: msToDate(now),
										disabledReason: "Last recipient left the organization",
									}
								: undefined),
						})
						.where(eq(alertDestinations.id, row.id)),
				)
				updated += 1
			}
			return updated
		},
	)

	const sweep = Effect.fnUntraced(function* (orgId: OrgId | null, userId: UserId) {
		yield* Effect.annotateCurrentSpan({
			...(orgId === null ? undefined : { orgId }),
			"tenant.userId": userId,
		})
		// First and unconditionally: it never fails, and until it runs the
		// `x-maple-org-id` header still selects this org for up to five minutes.
		yield* invalidateMembership(userId)

		const now = yield* Clock.currentTimeMillis
		const revokedAt = msToDate(now)

		// One transaction for the credential tables: a partial purge here is the
		// exact half-revoked state the whole fix exists to prevent.
		const credentials = yield* dbExecute((db) =>
			db.transaction(async (tx) => {
				const mcpFamiliesRevoked = await revokeRefreshFamiliesForMember(tx, orgId, userId, revokedAt)
				// After the families, so an MCP access key retired above is already
				// `revoked` and is simply not claimed twice.
				const revokedKeys = await tx
					.update(apiKeys)
					.set({ revoked: true, revokedAt })
					.where(
						and(
							...(orgId === null ? [] : [eq(apiKeys.orgId, orgId)]),
							eq(apiKeys.createdBy, userId),
							eq(apiKeys.revoked, false),
						),
					)
					.returning({ id: apiKeys.id })
				const cliDeleted = await tx
					.delete(cliDeviceAuthorizations)
					.where(
						and(
							...(orgId === null ? [] : [eq(cliDeviceAuthorizations.approvedOrgId, orgId)]),
							eq(cliDeviceAuthorizations.approvedUserId, userId),
						),
					)
					.returning({ deviceCodeHash: cliDeviceAuthorizations.deviceCodeHash })
				const mcpAuthDeleted = await tx
					.delete(mcpOAuthAuthorizations)
					.where(
						and(
							...(orgId === null ? [] : [eq(mcpOAuthAuthorizations.approvedOrgId, orgId)]),
							eq(mcpOAuthAuthorizations.approvedUserId, userId),
						),
					)
					.returning({ requestIdHash: mcpOAuthAuthorizations.requestIdHash })
				const devicesDeleted = await tx
					.delete(mobileDevices)
					.where(
						and(
							...(orgId === null ? [] : [eq(mobileDevices.orgId, orgId)]),
							eq(mobileDevices.userId, userId),
						),
					)
					.returning({ id: mobileDevices.id })
				return {
					apiKeysRevoked: revokedKeys.length,
					mcpFamiliesRevoked,
					cliAuthorizationsDeleted: cliDeleted.length,
					mcpAuthorizationsDeleted: mcpAuthDeleted.length,
					mobileDevicesDeleted: devicesDeleted.length,
				}
			}),
		)

		const emailDestinationsUpdated = yield* stripFromEmailDestinations(orgId, userId)

		const summary = { ...credentials, emailDestinationsUpdated } satisfies MembershipRevocationSummary
		yield* Effect.annotateCurrentSpan({
			"maple.membership.api_keys_revoked": summary.apiKeysRevoked,
			"maple.membership.mcp_families_revoked": summary.mcpFamiliesRevoked,
			"maple.membership.cli_authorizations_deleted": summary.cliAuthorizationsDeleted,
			"maple.membership.mcp_authorizations_deleted": summary.mcpAuthorizationsDeleted,
			"maple.membership.email_destinations_updated": summary.emailDestinationsUpdated,
			"maple.membership.mobile_devices_deleted": summary.mobileDevicesDeleted,
		})
		return summary
	})

	/**
	 * Demotion, the security-relevant direction of a role change. CLI, MCP and
	 * device keys pin the minting user's roles into `metadata_json` and
	 * `resolveByKey` reads them back without ever re-checking the membership, so
	 * an admin who ran `maple auth login` and was then demoted keeps admin on
	 * that key until it expires. Any key still pinned to an admin role the member
	 * no longer holds is retired here; MCP families go with their access key, or
	 * the next hourly rotation would mint the authority straight back.
	 *
	 * Known residue: a plain `standard` key carries no pinned roles and resolves
	 * with the `root` default, so a demoted admin's ordinary API keys keep full
	 * authority. Revoking those on demotion would silently break org automation
	 * an admin created for the org rather than for themselves, so it is left —
	 * deliberately, and stated rather than implied.
	 */
	const demoteMembership = Effect.fn("MembershipRevocationService.demoteMembership")(function* (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
	) {
		yield* Effect.annotateCurrentSpan({ orgId, "tenant.userId": userId })
		yield* invalidateMembership(userId)
		if (isAdmin(roles)) {
			return { apiKeysRevoked: 0, mcpFamiliesRevoked: 0 } satisfies MembershipDemotionSummary
		}

		const now = yield* Clock.currentTimeMillis
		const revokedAt = msToDate(now)
		const summary = yield* dbExecute((db) =>
			db.transaction(async (tx) => {
				const live = await tx
					.select({ id: apiKeys.id, metadataJson: apiKeys.metadataJson })
					.from(apiKeys)
					.where(
						and(
							eq(apiKeys.orgId, orgId),
							eq(apiKeys.createdBy, userId),
							eq(apiKeys.revoked, false),
						),
					)
				const stale = live
					.filter((row) => {
						const pinned = decodePinnedRoles(row.metadataJson)
						return pinned._tag === "Some" && isAdmin(pinned.value.roles)
					})
					.map((row) => row.id)
				if (stale.length === 0) return { apiKeysRevoked: 0, mcpFamiliesRevoked: 0 }

				const revoked = await tx
					.update(apiKeys)
					.set({ revoked: true, revokedAt })
					.where(and(inArray(apiKeys.id, stale), eq(apiKeys.revoked, false)))
					.returning({ id: apiKeys.id })
				const mcpFamiliesRevoked = await revokeFamiliesForAccessKeys(tx, stale, revokedAt)
				return { apiKeysRevoked: revoked.length, mcpFamiliesRevoked }
			}),
		)

		yield* Effect.annotateCurrentSpan({
			"maple.membership.demoted_api_keys_revoked": summary.apiKeysRevoked,
			"maple.membership.demoted_mcp_families_revoked": summary.mcpFamiliesRevoked,
		})
		return summary satisfies MembershipDemotionSummary
	})

	const revokeMembership = Effect.fn("MembershipRevocationService.revokeMembership")(
		(orgId: OrgId, userId: UserId) => sweep(orgId, userId),
	)
	const revokeUser = Effect.fn("MembershipRevocationService.revokeUser")((userId: UserId) =>
		sweep(null, userId),
	)

	return {
		revokeMembership,
		revokeUser,
		demoteMembership,
		invalidateMembership,
	} satisfies MembershipRevocationServiceApi
})

export class MembershipRevocationService extends Context.Service<
	MembershipRevocationService,
	MembershipRevocationServiceApi
>()("@maple/api/services/auth/MembershipRevocationService", { make }) {
	static readonly layer = Layer.effect(this, this.make)
}
