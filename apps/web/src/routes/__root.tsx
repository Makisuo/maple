import { lazy, memo, Suspense, useEffect } from "react"
import { useAuth } from "@clerk/clerk-react"
import { useMapleCustomer } from "@/hooks/use-maple-customer"
import {
	Navigate,
	Outlet,
	createRootRouteWithContext,
	redirect,
	useRouterState,
} from "@tanstack/react-router"
import { toast } from "sonner"
import { selectedPlanKnownAtomFor } from "@/atoms/selected-plan-atoms"
import { useAtom } from "@/lib/effect-atom"
import { hasSelectedPlan, isUsableCustomer } from "@/lib/billing/plan-gating"
import { parseRedirectUrl } from "@/lib/redirect-utils"
import { Toaster } from "@maple/ui/components/ui/sonner"
import { AttributesProvider } from "@maple/ui/components/attributes/context"
import { BootSplash } from "@/components/boot-splash"
import { highlightCode } from "@/lib/sugar-high"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import type { RouterAuthContext } from "@/router"
import type { EffectRouterContext } from "@effect-router/core"
import { captureChatReferrer } from "@/components/chat/auto-contexts"
import { GlobalChatSheet } from "@/components/chat/global-chat-sheet"
import { GlobalShortcuts } from "@/components/command-palette/global-shortcuts"
import { IdleRoutePrefetch } from "@/components/performance/idle-route-prefetch"

const UnitflowDevtools = import.meta.env.DEV
	? lazy(() =>
			import("@/components/devtools/unitflow-devtools").then((module) => ({
				default: module.UnitflowDevtools,
			})),
		)
	: null

const CommitShaAttributeValue = lazy(() =>
	import("@/components/attributes/commit-sha-attribute").then((module) => ({
		default: module.CommitShaAttributeValue,
	})),
)

const COMMIT_SHA_KEYS = new Set(["deployment.commit_sha", "vcs.ref.head.revision"])

function renderAttributeValue(attrKey: string, value: string) {
	if (!COMMIT_SHA_KEYS.has(attrKey)) return null
	return (
		<Suspense fallback={<span className="break-all">{value}</span>}>
			<CommitShaAttributeValue value={value} />
		</Suspense>
	)
}

const PUBLIC_PATHS = new Set([
	"/sign-in",
	"/sign-up",
	"/org-required",
	"/service-map-bench",
	"/service-detail-bench",
	"/infra-bench",
	"/logs-bench",
	"/overview-bench",
])

// Routes that render their own onboarding/billing UI and so must never be
// gated on plan selection (neither redirected away nor blocked while loading).
const ALLOWED_WITHOUT_PLAN = ["/select-plan", "/quick-start", "/cli-login", "/mcp-authorize"]

// Stable references so the AttributesProvider context value never changes
// identity across renders (avoids re-rendering every CopyableValue consumer).
const notifyCopied = (message?: string) => toast.success(message ?? "Copied to clipboard")

export const Route = createRootRouteWithContext<{ auth: RouterAuthContext } & EffectRouterContext>()({
	beforeLoad: ({ context, location }) => {
		if (PUBLIC_PATHS.has(location.pathname)) return

		const redirectUrl = location.pathname + (location.searchStr ?? "")

		if (!context.auth?.isAuthenticated) {
			throw redirect({
				to: "/sign-in",
				search: { redirect_url: redirectUrl } as Record<string, string>,
			})
		}

		if (!context.auth.orgId) {
			throw redirect({
				to: "/org-required",
				search: { redirect_url: redirectUrl } as Record<string, string>,
			})
		}
	},
	component: RootComponent,
})

// Memoized so root-level churn (Clerk session touches, customer-query state
// transitions in ClerkReverseRedirects) stops here instead of cascading into
// the entire route tree on every commit.
const AppFrame = memo(function AppFrame() {
	const pathname = useRouterState({ select: (s) => s.location.pathname })
	useEffect(() => {
		captureChatReferrer(pathname)
	}, [pathname])
	return (
		<AttributesProvider
			notifyCopied={notifyCopied}
			highlightJson={highlightCode}
			renderValue={renderAttributeValue}
		>
			<Outlet />
			<Toaster />
			{!PUBLIC_PATHS.has(pathname) && <IdleRoutePrefetch />}
			{!PUBLIC_PATHS.has(pathname) && (
				<>
					<GlobalShortcuts />
					<GlobalChatSheet />
				</>
			)}
			{UnitflowDevtools && (
				<Suspense fallback={null}>
					<UnitflowDevtools />
				</Suspense>
			)}
		</AttributesProvider>
	)
})

function getRedirectTarget(searchStr: string, fallback = "/") {
	const params = new URLSearchParams(searchStr)
	const target = params.get("redirect_url")
	if (!target || !target.startsWith("/")) return parseRedirectUrl(fallback)
	return parseRedirectUrl(target)
}

function getSignUpRedirectTarget(searchStr: string) {
	const target = new URLSearchParams(searchStr).get("redirect_url")
	if (!target || target === "/" || !target.startsWith("/")) {
		return parseRedirectUrl("/quick-start")
	}
	return parseRedirectUrl(target)
}

function ClerkReverseRedirects() {
	const { pathname, searchStr } = useRouterState({
		select: (state) => ({
			pathname: state.location.pathname,
			searchStr: state.location.searchStr,
		}),
	})
	const { isSignedIn, orgId } = useAuth()
	// Autumn customers are keyed by orgId, so getOrCreateCustomer can only
	// succeed once an org is active. Skip the fetch for signed-out/org-less
	// onboarding sessions (e.g. /sign-up, /org-required) to avoid guaranteed 401s.
	const {
		data: customer,
		isLoading: isCustomerLoading,
		error: customerError,
	} = useMapleCustomer({ queryOptions: { enabled: Boolean(isSignedIn && orgId) } })

	const redirectUrl = pathname + (searchStr ?? "")
	const selectedPlan = hasSelectedPlan(customer)

	// Per-org, localStorage-backed memory (effect-atom KVS) of whether this org
	// was last seen on an active selected plan. Drives the optimistic "render the
	// dashboard while the plan is still loading" fast path below. Falls back to an
	// inert in-memory atom while there's no org (org-less / still-settling auth).
	const [knownSelectedPlan, setKnownSelectedPlan] = useAtom(selectedPlanKnownAtomFor(orgId))

	// Once the customer query settles to a usable payload, record whether this
	// org holds an active selected plan, so the flag only ever reflects a
	// genuinely-known plan state — skip while loading or on an error/unusable
	// payload so a transient blip can't flip it. A planless settle (e.g.
	// unsubscribe) clears it here, ending the optimistic flash. See MAP-45.
	useEffect(() => {
		if (!isSignedIn || !orgId || isCustomerLoading) return
		if (customerError || !isUsableCustomer(customer)) return
		setKnownSelectedPlan(selectedPlan)
	}, [isSignedIn, orgId, isCustomerLoading, customerError, customer, selectedPlan, setKnownSelectedPlan])

	if (isSignedIn && pathname === "/sign-in") {
		const target = getRedirectTarget(searchStr)
		return <Navigate to={target.pathname} search={target.search} replace />
	}

	if (isSignedIn && pathname === "/sign-up") {
		const target = getSignUpRedirectTarget(searchStr)
		return <Navigate to={target.pathname} search={target.search} replace />
	}

	if (isSignedIn && orgId && pathname === "/org-required") {
		const target = getRedirectTarget(searchStr)
		return <Navigate to={target.pathname} search={target.search} replace />
	}

	if (isSignedIn && orgId) {
		// If Autumn is down — or returns an error-shaped `200` payload that isn't
		// a usable customer — let users through rather than blocking them. Without
		// this, a malformed customer falls through as "no plan" and bounces the
		// user into /quick-start onboarding.
		if (customerError || (customer && !isUsableCustomer(customer))) {
			return <AppFrame />
		}
		// Dev-only: `?quota_preview=` forces the usage-alert banner for visual
		// review; render the shell without waiting on the customer query (which
		// may stall when Autumn isn't configured locally).
		const quotaPreview =
			import.meta.env.DEV &&
			typeof window !== "undefined" &&
			window.location.search.includes("quota_preview")
		// Plan not yet known (query still loading/retrying). Allowed-without-plan
		// routes render their own onboarding UI, so let them through. For every
		// other route, only optimistically render the dashboard when this browser
		// already knows the org holds a selected plan — otherwise show a loading
		// screen until the query settles, so we never flash the dashboard before
		// bouncing a planless user to /quick-start. The flag is cleared on
		// unsubscribe, so that case flashes once and then takes the wait path.
		if (isCustomerLoading && !quotaPreview) {
			if (ALLOWED_WITHOUT_PLAN.includes(pathname) || knownSelectedPlan) {
				return <AppFrame />
			}
			return <BootSplash />
		}

		// Plan known (or dev quota preview): apply the gate.
		if (!selectedPlan && !quotaPreview && !ALLOWED_WITHOUT_PLAN.includes(pathname)) {
			return <Navigate to="/quick-start" search={{ redirect_url: redirectUrl }} replace />
		}
		if (selectedPlan && pathname === "/select-plan") {
			const target = getRedirectTarget(searchStr)
			return <Navigate to={target.pathname} search={target.search} replace />
		}
	}

	return <AppFrame />
}

function RootComponent() {
	if (!isClerkAuthEnabled) {
		return <AppFrame />
	}

	return <ClerkReverseRedirects />
}
