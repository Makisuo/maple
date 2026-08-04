import { useAuth, useOrganization, useUser } from "@clerk/clerk-react"
import { identify } from "@maple-dev/effect-sdk/client"
import { useEffect } from "react"
import { clearMapleAuthHeaders, setActiveOrgId, setMapleAuthHeadersProvider } from "./auth-headers"

export function ClerkAuthBridge() {
	const { isLoaded, isSignedIn, getToken, orgId, userId } = useAuth()
	const { isLoaded: isUserLoaded, user } = useUser()
	const { isLoaded: isOrgLoaded, organization } = useOrganization()

	// Read the identity out as primitives so the effect's deps are stable strings
	// rather than Clerk's resource objects, which are new on every poll.
	const userName = user?.fullName ?? user?.username ?? undefined
	const userEmail = user?.primaryEmailAddress?.emailAddress
	const groupName = organization?.name

	// Publish the active org so org-scoped client caches re-key on org switch
	// (which invalidates the router but not module-level state). Also tag the
	// effect-sdk browser session/replay with the signed-in user and their org:
	// telemetry inits at module load (before Clerk), so the session starts
	// anonymous; `identify()` is read lazily when session rows post and spans are
	// created, so a late call still attaches the identity. External-system sync,
	// like the auth-headers bridge below.
	//
	// We send the full identity — name, email and org name, not just the ids —
	// so our own instance exercises exactly the path a customer's does, and the
	// Sessions list labels our rows the way theirs are labelled instead of by an
	// opaque `user_...`. `groupId`/`groupName` are what make it groupable by org.
	//
	// Gated on all three `isLoaded` flags: identity replaces rather than merges,
	// so a partial call is harmless in itself, but any metadata row posted in the
	// window between a partial and a full call would carry a blank name.
	useEffect(() => {
		setActiveOrgId(isLoaded && isSignedIn ? orgId : null)
		if (isLoaded && isUserLoaded && isOrgLoaded) {
			identify(
				isSignedIn && userId
					? {
							id: userId,
							username: userName,
							email: userEmail,
							groupId: orgId ?? undefined,
							groupName,
						}
					: undefined,
			)
		}
	}, [isLoaded, isUserLoaded, isOrgLoaded, isSignedIn, orgId, userId, userName, userEmail, groupName])

	useEffect(() => {
		if (!isLoaded || !isSignedIn) {
			setMapleAuthHeadersProvider(undefined)
			clearMapleAuthHeaders()
			return
		}

		setMapleAuthHeadersProvider(async (): Promise<Record<string, string>> => {
			const token = await getToken()
			if (!token) return {}

			return {
				authorization: `Bearer ${token}`,
			}
		})

		return () => {
			setMapleAuthHeadersProvider(undefined)
		}
	}, [getToken, isLoaded, isSignedIn])

	return null
}
