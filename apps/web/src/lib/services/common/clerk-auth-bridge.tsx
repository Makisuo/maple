import { useAuth } from "@clerk/clerk-react"
import { identify } from "@maple-dev/effect-sdk/client"
import { useEffect } from "react"
import { clearMapleAuthHeaders, setActiveOrgId, setMapleAuthHeadersProvider } from "./auth-headers"

export function ClerkAuthBridge() {
	const { isLoaded, isSignedIn, getToken, orgId, userId } = useAuth()

	// Publish the active org so org-scoped client caches re-key on org switch
	// (which invalidates the router but not module-level state). Also tag the
	// effect-sdk browser session/replay with the signed-in user and their org:
	// telemetry inits at module load (before Clerk), so the session starts
	// anonymous; `identify()` is read lazily when session rows post and spans are
	// created, so a late call still attaches the identity. External-system sync,
	// like the auth-headers bridge below.
	//
	// `groupId` is what makes the Sessions UI groupable by org. The email is
	// deliberately not sent: this is our own dogfooding instance, and the Clerk
	// user id already joins to everything we'd want it for — the capability is
	// there for customers, not for us.
	useEffect(() => {
		setActiveOrgId(isLoaded && isSignedIn ? orgId : null)
		if (isLoaded) {
			identify(isSignedIn && userId ? { id: userId, groupId: orgId ?? undefined } : undefined)
		}
	}, [isLoaded, isSignedIn, orgId, userId])

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
