import { useAuth } from "@clerk/clerk-react"
import { useEffect } from "react"
import { clearMapleAuthHeaders, setMapleAuthHeadersProvider } from "./auth-headers"

export function ClerkAuthBridge() {
	const { isLoaded, isSignedIn, getToken } = useAuth()

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
