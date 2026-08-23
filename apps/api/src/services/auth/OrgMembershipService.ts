import { createClerkClient } from "@clerk/backend"
import { EdgeCacheService } from "@maple/cache"
import type { VerifiedOrgMembership } from "@maple/auth"
import { AuthorizationUnavailableError, OrgId, RoleName, type UserId } from "@maple/domain/http"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Env } from "@/platform/Env"
import { clerkRequest } from "@/services/auth/clerk-request"

export interface OrgMembershipServiceApi {
	/**
	 * Is `userId` a member of `orgId`, and with what role?
	 *
	 * `Option.none()` is a definite no. A failure is "could not find out" — the
	 * caller must reject the request, never fall back to the credential's own
	 * organization: a Clerk blip would otherwise render one org's incidents under
	 * another org's name.
	 */
	readonly verify: (
		userId: UserId,
		orgId: OrgId,
	) => Effect.Effect<Option.Option<VerifiedOrgMembership>, AuthorizationUnavailableError>
}

/**
 * Membership lookups are keyed by **user**, never by (user, org).
 *
 * The org in the key would be attacker-controlled — it arrives in a request
 * header — so a per-pair cache turns the header into a Clerk-request amplifier:
 * rotate the value and every request misses and dials out. Caching the whole
 * membership set per user means header rotation costs zero extra outbound
 * calls, and negative answers come for free.
 */
export const ORG_MEMBERSHIP_CACHE_BUCKET = "org-membership"

/**
 * How long a membership answer is trusted, in two tiers.
 *
 * **The shared TTL is the revocation lag**: for up to five minutes after being
 * removed from an organization, a user can still select it with the header.
 * That is a deliberate, tunable number and it is strictly tighter than nothing —
 * but it is looser than the token path, where Clerk session tokens last ~60s.
 * If it ever needs to be tighter, lower it; the traffic here is widget refreshes
 * and the extra Clerk volume is small. Do not "fix" it by removing the cache:
 * this read sits in auth, in front of every request that carries the header.
 *
 * A Clerk webhook on `organizationMembership.deleted`/`.updated` calling
 * `edgeCache.invalidate({ bucket, key: userId })` would close the window
 * properly, and is the follow-up worth doing.
 */
const MEMBERSHIP_MEMO_TTL_MS = 60_000
const MEMBERSHIP_CACHE_TTL_SECONDS = 300

/**
 * Well above the service default (40ms). That deadline's premise is that
 * abandoning a read is cheap because `compute` was going to open a connection
 * anyway — here `compute` is a round-trip to Clerk, which is exactly the case
 * `readTimeoutMs` exists for.
 */
const MEMBERSHIP_CACHE_READ_TIMEOUT_MS = 200

const MEMBERSHIP_PAGE_SIZE = 100
/** 500 organizations. Past that, `truncated` sends the miss to a pair lookup. */
const MEMBERSHIP_MAX_PAGES = 5

const CachedMemberships = Schema.Struct({
	memberships: Schema.Array(Schema.Struct({ orgId: OrgId, role: RoleName })),
	truncated: Schema.Boolean,
})
type CachedMemberships = Schema.Schema.Type<typeof CachedMemberships>

interface MemoEntry {
	readonly value: CachedMemberships
	readonly freshUntil: number
}

// Per-isolate tier. A warm isolate answers with zero network; the shared tier
// behind it is what keeps Clerk out of the path across isolates.
const membershipMemo = new Map<string, MemoEntry>()

const decodeOrgIdOption = Schema.decodeUnknownOption(OrgId)
const decodeRoleNameOption = Schema.decodeUnknownOption(RoleName)

const unavailable = (cause: unknown) =>
	new AuthorizationUnavailableError({
		message: `Could not verify organization membership: ${cause instanceof Error ? cause.message : String(cause)}`,
	})

/** One page of memberships, as much of it as Maple can model. */
export interface ClerkMembershipRow {
	readonly organization: { readonly id: string }
	readonly role: string
}

/**
 * Pages a user's memberships and decodes them, with the fetch injected so the
 * paging, the truncation flag and the drop-what-we-cannot-model rule are
 * testable without a Clerk client.
 */
export const collectMemberships = Effect.fnUntraced(function* (
	listPage: (
		offset: number,
	) => Effect.Effect<ReadonlyArray<ClerkMembershipRow>, AuthorizationUnavailableError>,
) {
	const memberships: Array<{ orgId: OrgId; role: RoleName }> = []
	let page = 0
	let truncated = false
	let undecodable = 0

	while (true) {
		const rows = yield* listPage(page * MEMBERSHIP_PAGE_SIZE)

		for (const row of rows) {
			const orgId = decodeOrgIdOption(row.organization.id)
			const role = decodeRoleNameOption(row.role)
			// A Clerk role Maple does not model must not 500 an unrelated request —
			// it simply is not a membership we can act on. Counted so the span says
			// it happened rather than the count quietly disagreeing with Clerk.
			if (Option.isNone(orgId) || Option.isNone(role)) {
				undecodable += 1
				continue
			}
			memberships.push({ orgId: orgId.value, role: role.value })
		}

		page += 1
		if (rows.length < MEMBERSHIP_PAGE_SIZE) break
		if (page >= MEMBERSHIP_MAX_PAGES) {
			truncated = true
			break
		}
	}

	yield* Effect.annotateCurrentSpan({
		"maple.auth.membership.count": memberships.length,
		"maple.auth.membership.truncated": truncated,
		"maple.auth.membership.undecodable": undecodable,
	})
	return { memberships, truncated } satisfies CachedMemberships
})

const make = Effect.gen(function* () {
	const env = yield* Env
	const edgeCache = yield* EdgeCacheService

	const clerk =
		env.MAPLE_AUTH_MODE.toLowerCase() === "clerk" && Option.isSome(env.CLERK_SECRET_KEY)
			? createClerkClient({ secretKey: Redacted.value(env.CLERK_SECRET_KEY.value) })
			: null

	const listFromClerk = (userId: UserId) =>
		collectMemberships((offset) => {
			if (clerk === null) return Effect.fail(unavailable("Clerk is not configured"))
			return clerkRequest(
				"Clerk.users.getOrganizationMembershipList",
				{ "tenant.userId": userId },
				() =>
					clerk.users.getOrganizationMembershipList({
						userId,
						limit: MEMBERSHIP_PAGE_SIZE,
						offset,
					}),
			).pipe(
				Effect.map((response) => response.data),
				Effect.mapError(unavailable),
			)
		})

	const readShared = (userId: UserId) =>
		edgeCache
			.getOrCompute(
				{
					bucket: ORG_MEMBERSHIP_CACHE_BUCKET,
					key: userId,
					ttlSeconds: MEMBERSHIP_CACHE_TTL_SECONDS,
					schema: CachedMemberships,
					readTimeoutMs: MEMBERSHIP_CACHE_READ_TIMEOUT_MS,
				},
				listFromClerk(userId),
			)
			.pipe(Effect.map((result) => result.value))

	const load = Effect.fn("OrgMembershipService.load")(function* (userId: UserId) {
		const now = Date.now()
		const memo = membershipMemo.get(userId)
		if (memo && now < memo.freshUntil) {
			yield* Effect.annotateCurrentSpan("cache.status", "memo")
			return memo.value
		}

		// Only successes are memoized. A Clerk failure is not a membership answer,
		// and caching it would turn one outage into a fixed window of wrong 403s.
		const value = yield* readShared(userId)
		membershipMemo.set(userId, { value, freshUntil: now + MEMBERSHIP_MEMO_TTL_MS })
		return value
	})

	/**
	 * The precise question, for the one case the per-user set cannot answer: a
	 * user in more organizations than we page through. Without it, a pathological
	 * account would be told it is not a member of an org it is in.
	 */
	const verifyPair = Effect.fn("OrgMembershipService.verifyPair")(function* (userId: UserId, orgId: OrgId) {
		if (clerk === null) return yield* Effect.fail(unavailable("Clerk is not configured"))
		const response = yield* clerkRequest(
			"Clerk.organizations.getOrganizationMembershipList",
			{ "tenant.userId": userId, orgId },
			() =>
				clerk.organizations.getOrganizationMembershipList({
					organizationId: orgId,
					userId: [userId],
					limit: 1,
				}),
		).pipe(Effect.mapError(unavailable))

		const membership = response.data[0]
		if (!membership) return Option.none<VerifiedOrgMembership>()
		const role = decodeRoleNameOption(membership.role)
		return Option.map(role, (value): VerifiedOrgMembership => ({ orgId, role: value }))
	})

	const verify = Effect.fn("OrgMembershipService.verify")(function* (userId: UserId, orgId: OrgId) {
		yield* Effect.annotateCurrentSpan({ "tenant.userId": userId, "tenant.requested_org_id": orgId })
		const { memberships, truncated } = yield* load(userId)
		const found = memberships.find((membership) => membership.orgId === orgId)
		if (found) return Option.some<VerifiedOrgMembership>(found)
		if (!truncated) return Option.none<VerifiedOrgMembership>()
		return yield* verifyPair(userId, orgId)
	})

	return { verify } satisfies OrgMembershipServiceApi
})

export class OrgMembershipService extends Context.Service<OrgMembershipService, OrgMembershipServiceApi>()(
	"@maple/api/services/auth/OrgMembershipService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
