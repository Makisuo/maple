import { useAuth } from "@clerk/clerk-react"
import { identify } from "@maple-dev/effect-sdk/client"
import { useEffect } from "react"
import { clearMapleAuthHeaders, setActiveOrgId, setMapleAuthHeadersProvider } from "./auth-headers"

export function ClerkAuthBridge() {
	const { isLoaded, isSignedIn, getToken, orgId, userId } = useAuth()

	// Publish the active org so org-scoped client caches re-key on org switch
	// (which invalidates the router but not module-level state). Also tag the
	// effect-sdk browser session/replay with the signed-in user id: telemetry
	// inits at module load (before Clerk), so the session starts anonymous;
	// `identify()` is read lazily when session rows post and spans are created,
	// so a late call still attaches the user. External-system sync, like the
	// auth-headers bridge below.
	useEffect(() => {
		setActiveOrgId(isLoaded && isSignedIn ? orgId : null)
		if (isLoaded && isSignedIn && userId) identify(userId)
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
