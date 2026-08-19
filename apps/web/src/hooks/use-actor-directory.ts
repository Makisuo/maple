import { useOrganization, useUser } from "@clerk/clerk-react"
import * as React from "react"

import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

/** A person, resolved from the workspace directory rather than a raw `user_…` id. */
export interface DirectoryPerson {
	readonly userId: string
	/** Best display name available: full name, else the email, else a short id. */
	readonly name: string
	readonly email: string | null
	readonly imageUrl: string | null
}

export interface ActorDirectory {
	/** `null` when the id is not a workspace member, or the directory is still loading. */
	readonly lookup: (userId: string) => DirectoryPerson | null
	/** The signed-in user, for composer affordances ("you"). */
	readonly me: DirectoryPerson | null
	readonly isLoaded: boolean
}

const EMPTY: ActorDirectory = { lookup: () => null, me: null, isLoaded: true }

/**
 * Workspace-member directory keyed by Clerk user id.
 *
 * Issue events only carry `userId`, so a timeline rendered straight off the API
 * reads `user_39XiUL1kAsfANmSdn0znVhUpH04` next to every comment. Clerk's
 * frontend memberships hook already has the names and avatars the settings page
 * shows; this turns them into a lookup the activity feed can use. Convenience
 * only — nothing here is a trust boundary, the server re-resolves ids on write.
 *
 * **Never call a Clerk hook outside Clerk mode.** `main.tsx` mounts
 * `ClerkProvider` only when `isClerkAuthEnabled`, and Clerk v5 hooks throw
 * without one — so the variant is picked at module scope off a build-time
 * constant, exactly as `use-organization-feature-flags.ts` does. Self-hosted
 * falls back to raw ids, which is what it renders today.
 */
function useClerkActorDirectory(): ActorDirectory {
	// pageSize past Clerk's default of 10 so a normal workspace resolves in one
	// page; anyone past 200 members degrades to raw ids for the tail rather than
	// paging on every timeline render.
	const { memberships, isLoaded } = useOrganization({
		memberships: { infinite: true, pageSize: 200 },
	})
	const { user } = useUser()

	const data = memberships?.data
	const byUserId = React.useMemo(() => {
		const map = new Map<string, DirectoryPerson>()
		for (const member of data ?? []) {
			const publicData = member.publicUserData
			const userId = publicData?.userId
			if (!userId) continue
			const email = publicData?.identifier ?? null
			const fullName = [publicData?.firstName, publicData?.lastName].filter(Boolean).join(" ")
			map.set(userId, {
				userId,
				name: fullName || email || shortId(userId),
				email,
				imageUrl: publicData?.imageUrl ?? null,
			})
		}
		return map
	}, [data])

	const me: DirectoryPerson | null = user
		? {
				userId: user.id,
				name: user.fullName ?? user.username ?? user.primaryEmailAddress?.emailAddress ?? "You",
				email: user.primaryEmailAddress?.emailAddress ?? null,
				imageUrl: user.imageUrl ?? null,
			}
		: null

	return React.useMemo(
		() => ({
			lookup: (userId: string) => byUserId.get(userId) ?? (me?.userId === userId ? me : null),
			me,
			isLoaded,
		}),
		[byUserId, me, isLoaded],
	)
}

function useSelfHostedActorDirectory(): ActorDirectory {
	return EMPTY
}

/** Trailing chunk of a Clerk id — still opaque, but not 32 characters of it. */
export function shortId(id: string): string {
	const withoutPrefix = id.includes("_") ? (id.split("_").at(-1) ?? id) : id
	return withoutPrefix.slice(0, 6)
}

export const useActorDirectory: () => ActorDirectory = isClerkAuthEnabled
	? useClerkActorDirectory
	: useSelfHostedActorDirectory
