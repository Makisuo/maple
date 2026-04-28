import { clearMapleAuthHeaders, setMapleAuthHeadersProvider } from "./auth-headers"

const SELF_HOSTED_TOKEN_STORAGE_KEY = "maple.self_hosted.token"
const SELF_HOSTED_AUTH_EVENT = "maple:self-hosted-auth-changed"

const unauthenticatedState = {
	isAuthenticated: false,
	orgId: null,
} as const

const dispatchSelfHostedAuthChanged = () => {
	window.dispatchEvent(new Event(SELF_HOSTED_AUTH_EVENT))
}

export const getSelfHostedSessionToken = (): string | null => {
	try {
		const token = window.sessionStorage.getItem(SELF_HOSTED_TOKEN_STORAGE_KEY)
		return token && token.length > 0 ? token : null
	} catch {
		return null
	}
}

export const setSelfHostedSessionToken = (token: string) => {
	try {
		window.sessionStorage.setItem(SELF_HOSTED_TOKEN_STORAGE_KEY, token)
	} catch {
		// Ignore storage failures; auth simply won't persist.
	}
	dispatchSelfHostedAuthChanged()
}

export const clearSelfHostedSessionToken = () => {
	try {
		window.sessionStorage.removeItem(SELF_HOSTED_TOKEN_STORAGE_KEY)
	} catch {
		// Ignore storage failures.
	}
	clearMapleAuthHeaders()
	dispatchSelfHostedAuthChanged()
}

export const installSelfHostedAuthHeadersProvider = () => {
	setMapleAuthHeadersProvider(async (): Promise<Record<string, string>> => {
		const token = getSelfHostedSessionToken()
		if (!token) return {}

		return {
			authorization: `Bearer ${token}`,
		}
	})
}

export const subscribeSelfHostedAuthChanges = (listener: () => void) => {
	window.addEventListener(SELF_HOSTED_AUTH_EVENT, listener)
	return () => {
		window.removeEventListener(SELF_HOSTED_AUTH_EVENT, listener)
	}
}

export const resolveSelfHostedRouterAuth = async (apiBaseUrl: string) => {
	const token = getSelfHostedSessionToken()
	if (!token) return unauthenticatedState

	try {
		const response = await window.fetch(`${apiBaseUrl}/api/auth/session`, {
			method: "GET",
			headers: {
				authorization: `Bearer ${token}`,
			},
		})

		if (!response.ok) {
			clearSelfHostedSessionToken()
			return unauthenticatedState
		}

		const body = (await response.json()) as { orgId?: unknown }

		if (typeof body.orgId !== "string" || body.orgId.length === 0) {
			clearSelfHostedSessionToken()
			return unauthenticatedState
		}

		return {
			isAuthenticated: true,
			orgId: body.orgId,
		} as const
	} catch {
		return unauthenticatedState
	}
}
