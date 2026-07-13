import { createClerkClient } from "@clerk/backend"
import type { OrgId } from "@maple/domain/http"
import { Context, Data, Effect, Layer, Option, Redacted } from "effect"
import { Env } from "../lib/Env"

export class OrgMembersError extends Data.TaggedError("@maple/api/services/OrgMembersError")<{
	readonly message: string
	/** User ids the caller supplied that are not members of the org. */
	readonly unknownUserIds?: ReadonlyArray<string>
}> {}

export interface OrgMember {
	readonly userId: string
	readonly email: string
	readonly name: string | null
}

export interface OrgMembersServiceShape {
	/**
	 * Resolve workspace-member user ids to their emails via the auth provider.
	 * Fails when any id is not a member of the org, or when member resolution
	 * is unavailable (self-hosted mode without Clerk).
	 */
	readonly resolveMembers: (
		orgId: OrgId,
		userIds: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<OrgMember>, OrgMembersError>
}

const make = Effect.gen(function* () {
	const env = yield* Env

	const clerk =
		env.MAPLE_AUTH_MODE.toLowerCase() === "clerk" && Option.isSome(env.CLERK_SECRET_KEY)
			? createClerkClient({ secretKey: Redacted.value(env.CLERK_SECRET_KEY.value) })
			: null

	const listMembers = (orgId: OrgId) =>
		Effect.gen(function* () {
			if (clerk === null) {
				return yield* Effect.fail(
					new OrgMembersError({
						message: "Workspace member lookup requires Clerk authentication",
					}),
				)
			}
			const PAGE_SIZE = 100
			let offset = 0
			const all: Array<OrgMember> = []
			while (true) {
				const page = yield* Effect.tryPromise({
					try: () =>
						clerk.organizations.getOrganizationMembershipList({
							organizationId: orgId,
							limit: PAGE_SIZE,
							offset,
						}),
					catch: () =>
						new OrgMembersError({ message: `Failed to list workspace members for ${orgId}` }),
				})
				for (const member of page.data) {
					const userId = member.publicUserData?.userId
					const email = member.publicUserData?.identifier
					if (!userId || !email) continue
					const name =
						[member.publicUserData?.firstName, member.publicUserData?.lastName]
							.filter(Boolean)
							.join(" ") || null
					all.push({ userId, email, name })
				}
				offset += page.data.length
				if (offset >= page.totalCount || page.data.length === 0) break
			}
			return all
		})

	const resolveMembers: OrgMembersServiceShape["resolveMembers"] = Effect.fn(
		"OrgMembersService.resolveMembers",
	)(function* (orgId: OrgId, userIds: ReadonlyArray<string>) {
		yield* Effect.annotateCurrentSpan("orgId", orgId)
		const members = yield* listMembers(orgId)
		const byUserId = new Map(members.map((member) => [member.userId, member]))
		const resolved: Array<OrgMember> = []
		const unknown: Array<string> = []
		const seen = new Set<string>()
		for (const raw of userIds) {
			const userId = raw.trim()
			if (userId.length === 0 || seen.has(userId)) continue
			seen.add(userId)
			const member = byUserId.get(userId)
			if (member === undefined) unknown.push(userId)
			else resolved.push(member)
		}
		if (unknown.length > 0) {
			return yield* Effect.fail(
				new OrgMembersError({
					message: "Some selected users are not members of this workspace",
					unknownUserIds: unknown,
				}),
			)
		}
		return resolved
	})

	return { resolveMembers } satisfies OrgMembersServiceShape
})

export class OrgMembersService extends Context.Service<OrgMembersService, OrgMembersServiceShape>()(
	"@maple/api/services/OrgMembersService",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
