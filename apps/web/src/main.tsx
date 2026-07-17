import { ClerkProvider, useAuth } from "@clerk/clerk-react"
import { StrictMode, memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
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
import { AppErrorBoundary } from "./components/app-error-boundary"
import { BootSplash } from "./components/boot-splash"
import { appRegistry } from "./lib/registry"
import { clearChunkReloadGuard, shouldAttemptChunkReload } from "./lib/chunk-reload"
import "./styles.css"

// Client telemetry for the dashboard itself comes from the effect-sdk client
// alone (see lib/services/common/otel-layer.ts): it instruments every Effect
// HTTP request, stamps `session.id` from its own bundled browser session, and
// records the rrweb session replay via the SDK's built-in replay engine
// (lazy-loaded chunk, on by default) — no `@maple-dev/browser` needed.

window.addEventListener("vite:preloadError", (event) => {
	if (shouldAttemptChunkReload()) {
		event.preventDefault()
		window.location.reload()
	}
})

window.addEventListener("load", () => {
	clearChunkReloadGuard()
})

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

const AUTH_SETTLE_TIMEOUT_MS = 2000
const PUBLIC_PATHS = ["/sign-in", "/sign-up", "/org-required", "/service-map-bench"]

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

// Memoized so ClerkInnerApp's rerenders (one per Clerk-internal emit — session
// touches, token refreshes) stop here: rerendering EffectRouterProvider
// rerenders the entire match tree, so without this every Clerk emit was a
// full-app render.
const RouterShell = memo(function RouterShell({ context }: { context: { auth: RouterAuthContext } }) {
	return <EffectRouterProvider router={router} registry={appRegistry} context={context} />
})

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

	// Stable identity across Clerk session touches that don't change
	// sign-in/org, so EffectRouterProvider doesn't see a new context prop on
	// every Clerk-internal update.
	const context = useMemo(
		() => ({ auth: { isAuthenticated: !!isSignedIn, orgId } }),
		[isSignedIn, orgId],
	)

	if (!settled) return <BootSplash />

	return <RouterShell context={context} />
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

	const context = useMemo(() => (auth ? { auth } : null), [auth])

	if (!context) {
		return <BootSplash />
	}

	return <RouterShell context={context} />
}

const app = isClerkAuthEnabled ? (
	<ClerkProvider
		publishableKey={clerkPublishableKey}
		signInUrl={clerkSignInUrl}
		signUpUrl={clerkSignUpUrl}
		signUpFallbackRedirectUrl="/quick-start"
		afterSignOutUrl={clerkSignInUrl}
	>
		<ClerkAuthBridge />
		<ClerkInnerApp />
	</ClerkProvider>
) : (
	<SelfHostedInnerApp />
)

ReactDOM.createRoot(root).render(
	<StrictMode>
		<AppErrorBoundary>{app}</AppErrorBoundary>
	</StrictMode>,
)
