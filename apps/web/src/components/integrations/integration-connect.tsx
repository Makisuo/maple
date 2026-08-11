import { createContext, use, useEffectEvent, useRef, useState } from "react"
import type React from "react"
import { Exit } from "effect"
import {
	CloudflareStartConnectRequest,
	GithubStartConnectRequest,
	HazelStartConnectRequest,
} from "@maple/domain/http"
import { toastManager } from "@maple/ui/components/ui/toast"

import { trackProduct } from "@/lib/analytics"
import { useAtomRefresh, useAtomSet } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { showErrorToast } from "@/lib/error-toast"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { IntegrationId } from "./integration-catalog"

/**
 * The lifted connect flow for an integration drill-in. Provided once per
 * drill-in by `IntegrationConnectProvider` so the header's Connect button and
 * the card's in-card action share one handler and one busy flag.
 */
export interface IntegrationConnect {
	readonly connect: () => void
	/** True while the start call is in flight — disables every Connect affordance at once. */
	readonly busy: boolean
	/**
	 * True while the OAuth popup is open (GitHub: plus a grace window after it
	 * closes) — the flow may still complete server-side, so pollers key off this.
	 */
	readonly popupActive: boolean
}

const IntegrationConnectContext = createContext<IntegrationConnect | null>(null)

/** Null for integrations without an OAuth connect flow (prometheus/warpstream). */
export function useIntegrationConnect(): IntegrationConnect | null {
	return use(IntegrationConnectContext)
}

/**
 * Mounts the matching OAuth connect flow for the drill-in. Scrape-based
 * integrations render children bare — `useIntegrationConnect()` stays null,
 * which is also the header's "no Connect button" signal.
 */
export function IntegrationConnectProvider({
	integration,
	children,
}: {
	integration: IntegrationId
	children: React.ReactNode
}) {
	switch (integration) {
		case "cloudflare":
			return <CloudflareConnectBoundary>{children}</CloudflareConnectBoundary>
		case "hazel":
			return <HazelConnectBoundary>{children}</HazelConnectBoundary>
		case "github":
			return <GithubConnectBoundary>{children}</GithubConnectBoundary>
		case "planetscale":
			return <PlanetscaleConnectBoundary>{children}</PlanetscaleConnectBoundary>
		default:
			return children
	}
}

/**
 * Shared popup choreography for the OAuth flows: open the popup synchronously
 * (inside the click) so the browser doesn't block it, point it at the authorize
 * URL once the start call returns, and poll the handle for closure —
 * cross-origin popups fire no "closed" event, and the refresh-on-close covers
 * the case where the success message never arrives (popup closed manually or
 * blocked) so the drill-in can't get stuck on a stale view.
 */
function useOAuthPopupFlow({
	windowName,
	windowFeatures,
	start,
	startErrorTitle,
	onClosed,
	closeGraceMs = 0,
}: {
	windowName: string
	windowFeatures: string
	start: () => Promise<Exit.Exit<{ readonly redirectUrl: string }, unknown>>
	startErrorTitle: string
	onClosed: () => void
	/** Keeps `popupActive` true for this long after close (GitHub's backfill-enqueue gap). */
	closeGraceMs?: number
}): IntegrationConnect {
	const [busy, setBusy] = useState(false)
	const popupRef = useRef<Window | null>(null)
	const closeGraceTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const [popupOpen, setPopupOpen] = useState(false)
	const [inCloseGrace, setInCloseGrace] = useState(false)

	const checkPopup = useEffectEvent(() => {
		if (!popupOpen || !(popupRef.current?.closed ?? true)) return
		popupRef.current = null
		setPopupOpen(false)
		if (closeGraceMs > 0) {
			setInCloseGrace(true)
			if (closeGraceTimeoutRef.current !== undefined) {
				clearTimeout(closeGraceTimeoutRef.current)
			}
			closeGraceTimeoutRef.current = setTimeout(() => setInCloseGrace(false), closeGraceMs)
		}
		onClosed()
	})

	// A mount-scoped interval is intentional: it watches a cross-origin popup,
	// including while the opener is hidden. Effect Event keeps current state/copy.
	useMountEffect(() => {
		// React Doctor cannot infer that useMountEffect is an Effect.
		// oxlint-disable-next-line react-doctor/rules-of-hooks
		const poll = () => checkPopup()
		const id = setInterval(poll, 500)
		return () => {
			clearInterval(id)
			if (closeGraceTimeoutRef.current !== undefined) {
				clearTimeout(closeGraceTimeoutRef.current)
			}
		}
	})

	async function connect() {
		const popup = window.open("", windowName, windowFeatures)
		popupRef.current = popup
		if (popup) setPopupOpen(true)
		setBusy(true)
		const result = await start()
		setBusy(false)
		if (Exit.isSuccess(result)) {
			const url = result.value.redirectUrl
			if (popup && !popup.closed) {
				popup.location.href = url
			} else {
				const reopened = window.open(url, windowName, windowFeatures)
				popupRef.current = reopened
				if (reopened) setPopupOpen(true)
			}
		} else {
			popup?.close()
			popupRef.current = null
			setPopupOpen(false)
			showErrorToast(result, { title: startErrorTitle })
		}
	}

	return { connect: () => void connect(), busy, popupActive: popupOpen || inCloseGrace }
}

/** The OAuth popup returns to this same SPA and posts a message before closing. */
function useIntegrationMessage(
	type: string,
	onMessage: (data: { status?: string; message?: string }) => void,
) {
	const handleMessage = useEffectEvent((event: MessageEvent) => {
		if (event.data?.type !== type) return
		// Every provider's popup posts back through here, so the activation event
		// is recorded once rather than in each card's success branch.
		if (event.data?.status === "success") {
			trackProduct("integration_connected", { provider: type.split(":").pop() ?? type })
		}
		onMessage(event.data)
	})
	useMountEffect(() => {
		// React Doctor cannot infer that useMountEffect is an Effect.
		// oxlint-disable-next-line react-doctor/rules-of-hooks
		const listener = (event: MessageEvent) => handleMessage(event)
		window.addEventListener("message", listener)
		return () => window.removeEventListener("message", listener)
	})
}

function CloudflareConnectBoundary({ children }: { children: React.ReactNode }) {
	const refreshStatus = useAtomRefresh(
		MapleApiAtomClient.query("integrations", "cloudflareStatus", {
			reactivityKeys: ["cloudflareIntegrationStatus"],
		}),
	)
	const refreshUsage = useAtomRefresh(
		MapleApiAtomClient.query("integrations", "cloudflareUsage", {
			reactivityKeys: ["cloudflareIntegrationUsage"],
		}),
	)
	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "cloudflareStart"), {
		mode: "promiseExit",
	})

	useIntegrationMessage("maple:integration:cloudflare", (data) => {
		if (data.status === "success") {
			toastManager.add({ title: "Cloudflare account connected", type: "success" })
			refreshStatus()
			refreshUsage()
		} else if (data.status === "error") {
			toastManager.add({ title: data.message ?? "Cloudflare connection failed", type: "error" })
		}
	})

	const value = useOAuthPopupFlow({
		windowName: "maple-cloudflare-connect",
		windowFeatures: "popup,width=520,height=680",
		start: () =>
			startConnect({
				payload: new CloudflareStartConnectRequest({ returnTo: window.location.href }),
				reactivityKeys: ["cloudflareIntegrationStatus"],
			}),
		startErrorTitle: "Failed to start Cloudflare connect flow",
		onClosed: () => {
			refreshStatus()
			refreshUsage()
		},
	})

	return <IntegrationConnectContext value={value}>{children}</IntegrationConnectContext>
}

function HazelConnectBoundary({ children }: { children: React.ReactNode }) {
	const refreshStatus = useAtomRefresh(
		MapleApiAtomClient.query("integrations", "hazelStatus", {
			reactivityKeys: ["hazelIntegrationStatus"],
		}),
	)
	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "hazelStart"), {
		mode: "promiseExit",
	})

	useIntegrationMessage("maple:integration:hazel", (data) => {
		if (data.status === "success") {
			toastManager.add({ title: "Hazel connected", type: "success" })
			refreshStatus()
		} else if (data.status === "error") {
			toastManager.add({ title: data.message ?? "Hazel connection failed", type: "error" })
		}
	})

	const value = useOAuthPopupFlow({
		windowName: "maple-hazel-connect",
		windowFeatures: "popup,width=520,height=640",
		start: () =>
			startConnect({
				payload: new HazelStartConnectRequest({ returnTo: window.location.href }),
				reactivityKeys: ["hazelIntegrationStatus"],
			}),
		startErrorTitle: "Failed to start Hazel connect flow",
		onClosed: refreshStatus,
	})

	return <IntegrationConnectContext value={value}>{children}</IntegrationConnectContext>
}

function GithubConnectBoundary({ children }: { children: React.ReactNode }) {
	const refreshStatus = useAtomRefresh(
		MapleApiAtomClient.query("integrations", "githubStatus", {
			reactivityKeys: ["githubIntegrationStatus"],
		}),
	)
	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "githubStart"), {
		mode: "promiseExit",
	})

	useIntegrationMessage("maple:integration:github", (data) => {
		if (data.status === "success") {
			toastManager.add({ title: "GitHub connected", type: "success" })
			refreshStatus()
		} else if (data.status === "error") {
			toastManager.add({ title: data.message ?? "GitHub connection failed", type: "error" })
		}
	})

	const value = useOAuthPopupFlow({
		windowName: "maple-github-connect",
		windowFeatures: "popup,width=600,height=720",
		start: () =>
			startConnect({
				payload: new GithubStartConnectRequest({ returnTo: window.location.href }),
				reactivityKeys: ["githubIntegrationStatus"],
			}),
		startErrorTitle: "Failed to start GitHub connect flow",
		onClosed: refreshStatus,
		// Repos backfill server-side after install with no push channel — keep the
		// card's status polling alive through the enqueue gap after the popup closes.
		closeGraceMs: 10_000,
	})

	return <IntegrationConnectContext value={value}>{children}</IntegrationConnectContext>
}

function PlanetscaleConnectBoundary({ children }: { children: React.ReactNode }) {
	const refreshStatus = useAtomRefresh(
		MapleApiV2AtomClient.query("planetscaleIntegration", "status", {
			reactivityKeys: ["planetscaleIntegration"],
		}),
	)
	const startConnect = useAtomSet(MapleApiV2AtomClient.mutation("planetscaleIntegration", "connect"), {
		mode: "promiseExit",
	})

	useIntegrationMessage("maple:integration:planetscale", (data) => {
		if (data.status === "success") {
			refreshStatus()
		} else if (data.status === "error") {
			toastManager.add({ title: data.message ?? "PlanetScale connection failed", type: "error" })
		}
	})

	const value = useOAuthPopupFlow({
		windowName: "maple-planetscale-connect",
		windowFeatures: "popup,width=520,height=680",
		// PlanetScale is the one provider on v2, whose wire format is snake_case —
		// adapt at the boundary rather than teaching the shared hook two shapes.
		start: () =>
			startConnect({
				payload: { return_to: window.location.href },
				reactivityKeys: ["planetscaleIntegration"],
			}).then(Exit.map(({ redirect_url }) => ({ redirectUrl: redirect_url }))),
		startErrorTitle: "Failed to start PlanetScale connect flow",
		onClosed: refreshStatus,
	})

	return <IntegrationConnectContext value={value}>{children}</IntegrationConnectContext>
}
