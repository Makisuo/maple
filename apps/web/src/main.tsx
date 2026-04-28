import { ClerkProvider, useAuth } from "@clerk/clerk-react"
import { AutumnProvider } from "autumn-js/react"
import { Component, StrictMode, useCallback, useEffect, useRef, useState } from "react"
import ReactDOM from "react-dom/client"
import { EffectRouterProvider } from "@effect-router/core/react"
import { apiBaseUrl } from "./lib/services/common/api-base-url"
import { ClerkAuthBridge } from "./lib/services/common/clerk-auth-bridge"
import { isClerkAuthEnabled } from "./lib/services/common/auth-mode"
import {
	installSelfHostedAuthHeadersProvider,
	resolveSelfHostedRouterAuth,
	subscribeSelfHostedAuthChanges,
} from "./lib/services/common/self-hosted-auth"
import { router, type RouterAuthContext } from "./router"
import { appRegistry } from "./lib/registry"
import "./styles.css"

const root = document.getElementById("app")

if (!root) {
	throw new Error("App root element not found")
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim()
const clerkSignInUrl = import.meta.env.VITE_CLERK_SIGN_IN_URL?.trim() || "/sign-in"
const clerkSignUpUrl = import.meta.env.VITE_CLERK_SIGN_UP_URL?.trim() || "/sign-up"

if (import.meta.env.DEV && isClerkAuthEnabled && !clerkPublishableKey) {
	throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required when VITE_MAPLE_AUTH_MODE=clerk")
}

/**
 * Intercept fetch for Autumn API calls to inject the Clerk bearer token.
 *
 * Autumn SDK v1 removed the `getBearerToken` provider prop and doesn't expose
 * any other extension point for custom auth headers. The SDK's internal client
 * calls `window.fetch` directly, so this interceptor is the only way to attach
 * the Clerk JWT without forking the SDK.
 */
function useAutumnFetchAuth() {
	const { getToken } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	useEffect(() => {
		const original = window.fetch.bind(window)
		window.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
			if (url.includes("/api/autumn/")) {
				const token = await getTokenRef.current()
				if (token) {
					const headers = new Headers(init?.headers)
					headers.set("Authorization", `Bearer ${token}`)
					return original(input, { ...init, headers })
				}
			}
			return original(input, init)
		}
		return () => {
			window.fetch = original
		}
	}, [])
}

function AutumnProviderWithClerk({ children }: { children: React.ReactNode }) {
	useAutumnFetchAuth()

	return <AutumnProvider backendUrl={apiBaseUrl}>{children}</AutumnProvider>
}

class AutumnErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean }> {
	state = { hasError: false }
	static getDerivedStateFromError() {
		return { hasError: true }
	}
	componentDidCatch(error: Error) {
		console.error("[Autumn] Provider error, bypassing billing:", error)
	}
	render() {
		return this.props.children
	}
}

const AUTH_SETTLE_TIMEOUT_MS = 2000
const PUBLIC_PATHS = ["/sign-in", "/sign-up", "/org-required"]

/**
 * Wait for Clerk's auth state to settle before rendering the router.
 *
 * On hard refresh Clerk may briefly report `isSignedIn = false` while the
 * session token is being refreshed. If we render the router in that window,
 * `beforeLoad` redirects to `/sign-in` and the original URL is lost.
 *
 * This hook delays rendering until either:
 * - `isSignedIn` becomes `true` (token refresh completed), or
 * - the safety timeout expires (user is genuinely unauthenticated).
 */
function useClerkAuthSettled() {
	const { isLoaded, isSignedIn, orgId } = useAuth()
	const [settled, setSettled] = useState(false)
	const hasRenderedRouter = useRef(false)

	useEffect(() => {
		if (!isLoaded) return

		if (isSignedIn) {
			setSettled(true)
			return
		}

		if (PUBLIC_PATHS.includes(window.location.pathname)) {
			setSettled(true)
			return
		}

		if (hasRenderedRouter.current) {
			setSettled(true)
			return
		}

		const timer = setTimeout(() => setSettled(true), AUTH_SETTLE_TIMEOUT_MS)
		return () => clearTimeout(timer)
	}, [isLoaded, isSignedIn])

	useEffect(() => {
		if (settled) hasRenderedRouter.current = true
	}, [settled])

	return { settled, isSignedIn, orgId }
}

function ClerkInnerApp() {
	const { settled, isSignedIn, orgId } = useClerkAuthSettled()
	const isRouterMountedRef = useRef(false)

	useEffect(() => {
		if (!settled) return
		if (!isRouterMountedRef.current) {
			isRouterMountedRef.current = true
			return () => {
				isRouterMountedRef.current = false
			}
		}
		router.invalidate()
	}, [settled, isSignedIn, orgId])

	if (!settled) return null

	return (
		<EffectRouterProvider
			router={router}
			registry={appRegistry}
			context={{ auth: { isAuthenticated: !!isSignedIn, orgId } }}
		/>
	)
}

function SelfHostedInnerApp() {
	const [auth, setAuth] = useState<RouterAuthContext | null>(null)

	const refreshAuth = useCallback(async () => {
		const nextAuth = await resolveSelfHostedRouterAuth(apiBaseUrl)
		setAuth(nextAuth)
	}, [])

	useEffect(() => {
		installSelfHostedAuthHeadersProvider()
		void refreshAuth()

		return subscribeSelfHostedAuthChanges(() => {
			void refreshAuth()
		})
	}, [refreshAuth])

	useEffect(() => {
		if (!auth) return
		router.invalidate()
	}, [auth])

	if (!auth) {
		return null
	}

	return <EffectRouterProvider router={router} registry={appRegistry} context={{ auth }} />
}

const app = isClerkAuthEnabled ? (
	<ClerkProvider
		publishableKey={clerkPublishableKey}
		signInUrl={clerkSignInUrl}
		signUpUrl={clerkSignUpUrl}
		afterSignOutUrl={clerkSignInUrl}
	>
		<ClerkAuthBridge />
		<AutumnErrorBoundary>
			<AutumnProviderWithClerk>
				<ClerkInnerApp />
			</AutumnProviderWithClerk>
		</AutumnErrorBoundary>
	</ClerkProvider>
) : (
	<SelfHostedInnerApp />
)

ReactDOM.createRoot(root).render(<StrictMode>{app}</StrictMode>)
