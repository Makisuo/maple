import { createClerkClient } from "@clerk/backend"
import type { OrgId } from "@maple/domain/http"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Env } from "@/platform/Env"
import { clerkRequest } from "@/services/auth/clerk-request"

export class OrgMembersError extends Schema.TaggedError<OrgMembersError>()(
	"@maple/api/services/OrgMembersError",
	{
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Defect()),
		/** User ids the caller supplied that are not members of the org. */
		unknownUserIds: Schema.optionalKey(Schema.Array(Schema.String)),
	},
) {}

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

	const listMembers = Effect.fn("OrgMembersService.listMembers")(function* (orgId: OrgId) {
		yield* Effect.annotateCurrentSpan("orgId", orgId)
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
			const page = yield* clerkRequest(
				"Clerk.organizations.getOrganizationMembershipList",
				{ orgId },
				() =>
					clerk.organizations.getOrganizationMembershipList({
						organizationId: orgId,
						limit: PAGE_SIZE,
						offset,
					}),
			).pipe(
				Effect.mapError(
					(cause) =>
						new OrgMembersError({
							message: `Failed to list workspace members for ${orgId}`,
							cause,
						}),
				),
			)
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
		yield* Effect.annotateCurrentSpan({
			orgId,
			"maple.organization.member.requested_count": userIds.length,
		})
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
		yield* Effect.annotateCurrentSpan("result.member_count", resolved.length)
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
