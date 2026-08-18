import { apiBaseUrl } from "./api-base-url"
import {
	clearMapleAuthHeaders,
	readJwtExpMs,
	setActiveOrgId,
	setMapleAuthHeadersProvider,
} from "./auth-headers"
import { tracedFetch } from "./telemetry"

const SELF_HOSTED_TOKEN_STORAGE_KEY = "maple.self_hosted.token"
const SELF_HOSTED_AUTH_EVENT = "maple:self-hosted-auth-changed"

/**
 * Renew this far ahead of the token's own expiry. Wide enough that a laptop
 * asleep through the tail of a token's life still wakes up inside the window,
 * and that a renewal can fail and be retried on later requests before anything
 * user-visible happens.
 */
const RENEW_WHEN_REMAINING_MS = 5 * 60 * 1000

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
	setActiveOrgId(null)
	dispatchSelfHostedAuthChanged()
}

/**
 * Single-flight, keyed on the token being replaced: a burst of requests all
 * finding the same near-expiry token must produce ONE renewal, and a renewal
 * started against a token we have since replaced must not be joined by callers
 * holding the newer one.
 */
let inFlightRenewal: { readonly token: string; readonly promise: Promise<string | null> } | undefined

/**
 * Trade a near-expiry token for a fresh one. Returns the token to use, or `null`
 * when the session is genuinely over and the operator has to sign in again.
 *
 * The three outcomes are deliberately distinct: a rejected token ends the session
 * (the absolute cap was reached, or the root password was rotated), a transient
 * failure keeps the current token so an offline blip doesn't sign anyone out, and
 * success swaps in the new one.
 */
const renewSessionToken = async (token: string): Promise<string | null> => {
	if (inFlightRenewal?.token === token) return inFlightRenewal.promise

	const promise = (async (): Promise<string | null> => {
		let response: Response
		try {
			response = await tracedFetch("maple-api", `${apiBaseUrl}/api/auth/session/refresh`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
			})
		} catch {
			return token
		}

		if (response.status === 401 || response.status === 403) {
			clearSelfHostedSessionToken()
			return null
		}

		if (!response.ok) return token

		try {
			const body = (await response.json()) as { token?: unknown }
			if (typeof body.token !== "string" || body.token.length === 0) return token
			setSelfHostedSessionToken(body.token)
			return body.token
		} catch {
			return token
		}
	})().finally(() => {
		if (inFlightRenewal?.token === token) inFlightRenewal = undefined
	})

	inFlightRenewal = { token, promise }
	return promise
}

const resolveSessionBearer = async (): Promise<string | null> => {
	const token = getSelfHostedSessionToken()
	if (!token) return null

	const expiresAt = readJwtExpMs(token)
	// A token minted before self-hosted sessions had an expiry carries no `exp`,
	// so there is no deadline to renew ahead of. It keeps working until the server
	// ages it out under the max-lifetime rule, at which point signing in again
	// yields a bounded, renewable one. This branch disappears with those tokens.
	if (expiresAt === undefined) return token
	if (expiresAt - Date.now() > RENEW_WHEN_REMAINING_MS) return token

	return await renewSessionToken(token)
}

export const installSelfHostedAuthHeadersProvider = () => {
	// The header provider is also the renewal point. `auth-headers` caches these
	// headers against the JWT `exp` it can now read, so this runs about once per
	// token lifetime rather than once per request — and its 401 retry re-enters
	// here after invalidating, which is the recovery path when a token expires
	// earlier than the client expected (clock skew, a suspended laptop).
	setMapleAuthHeadersProvider(async (): Promise<Record<string, string>> => {
		const token = await resolveSessionBearer()
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
		const response = await tracedFetch("maple-api", `${apiBaseUrl}/api/auth/session`, {
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

		setActiveOrgId(body.orgId)
		return {
			isAuthenticated: true,
			orgId: body.orgId,
		} as const
	} catch {
		return unauthenticatedState
	}
}
