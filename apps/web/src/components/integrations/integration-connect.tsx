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
import { MapleApiAtomClient, retainedQuery } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { showErrorToast } from "@/lib/error-toast"
import { useMountEffect } from "@/hooks/use-mount-effect"
import type { IntegrationId } from "./integration-catalog"

export interface IntegrationConnect {
	readonly connect: () => void
	readonly busy: boolean
	readonly popupActive: boolean
}

const IntegrationConnectContext = createContext<IntegrationConnect | null>(null)

export function useIntegrationConnect(): IntegrationConnect | null {
	return use(IntegrationConnectContext)
}

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

// Open synchronously to avoid popup blocking; cross-origin closure must be polled.
const POPUP_TICK_MS = 500
/** Ticks between `onPoll` calls — 3s, brisk enough to feel immediate without hammering the API. */
const POLL_EVERY_TICKS = 6

/**
 * Placeholder for the popup between `window.open` and the authorize redirect. The window has to be
 * opened inside the click to survive the popup blocker, but the redirect URL only exists once the
 * start mutation answers — without this the user watches a blank white window for that round trip.
 */
const interimDocument = (label: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Connecting to ${label}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size:13px;
    background:#fff; color:#3f3f46; }
  @media (prefers-color-scheme: dark) { body { background:#1c1917; color:#d6d3d1; } }
</style></head><body>Connecting to ${label}…</body></html>`

function useOAuthPopupFlow({
	windowName,
	windowFeatures,
	label,
	start,
	startErrorTitle,
	onClosed,
	onPoll,
	closeGraceMs = 0,
}: {
	windowName: string
	windowFeatures: string
	/** Provider name, shown in the popup while the authorize URL is being fetched. */
	label: string
	start: () => Promise<Exit.Exit<{ readonly redirectUrl: string }, unknown>>
	startErrorTitle: string
	onClosed: () => void
	/**
	 * Called every few seconds while the popup is out. The provider's own page may sever
	 * `window.opener` (Cross-Origin-Opener-Policy), which drops the callback's postMessage and
	 * can make the popup read as closed the moment it navigates — so a flow that only reacts to
	 * the message, or only to the close, has cases where the dashboard never updates at all.
	 * Polling here is what makes the outcome converge regardless of which signal survived.
	 */
	onPoll?: () => void
	closeGraceMs?: number
}): IntegrationConnect {
	const [busy, setBusy] = useState(false)
	const popupRef = useRef<Window | null>(null)
	const closeGraceTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const tickRef = useRef(0)
	const [popupOpen, setPopupOpen] = useState(false)
	const [inCloseGrace, setInCloseGrace] = useState(false)

	const tick = useEffectEvent(() => {
		if (onPoll && (popupOpen || inCloseGrace)) {
			tickRef.current += 1
			if (tickRef.current % POLL_EVERY_TICKS === 0) onPoll()
		}
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

	useMountEffect(() => {
		// react-doctor-disable-next-line react-doctor/rules-of-hooks -- React Doctor does not recognize useMountEffect as an Effect Event boundary.
		const poll = () => tick()
		const id = setInterval(poll, POPUP_TICK_MS)
		return () => {
			clearInterval(id)
			if (closeGraceTimeoutRef.current !== undefined) {
				clearTimeout(closeGraceTimeoutRef.current)
			}
		}
	})

	/** A blocked popup used to fail silently — the button just did nothing, twice. */
	const reportBlocked = () =>
		toastManager.add({
			title: `Your browser blocked the ${label} window`,
			description: "Allow pop-ups for this site, then try connecting again.",
			type: "error",
		})

	async function connect() {
		const popup = window.open("", windowName, windowFeatures)
		popupRef.current = popup
		if (popup) {
			setPopupOpen(true)
			popup.document.write(interimDocument(label))
			popup.document.close()
		}
		setBusy(true)
		const result = await start()
		setBusy(false)
		if (Exit.isSuccess(result)) {
			const url = result.value.redirectUrl
			if (popup && !popup.closed) {
				popup.location.href = url
				return
			}
			// The gesture that would let this through is long gone, so this only succeeds when the
			// first open was closed rather than blocked — say so instead of no-oping.
			const reopened = window.open(url, windowName, windowFeatures)
			popupRef.current = reopened
			if (reopened) setPopupOpen(true)
			else reportBlocked()
		} else {
			popup?.close()
			popupRef.current = null
			setPopupOpen(false)
			showErrorToast(result, { title: startErrorTitle })
		}
	}

	return { connect: () => void connect(), busy, popupActive: popupOpen || inCloseGrace }
}

function useIntegrationMessage(
	type: string,
	onMessage: (data: { status?: string; message?: string }) => void,
) {
	const handleMessage = useEffectEvent((event: MessageEvent) => {
		if (event.data?.type !== type) return
		if (event.data?.status === "success") {
			trackProduct("integration_connected", { provider: type.split(":").pop() ?? type })
		}
		onMessage(event.data)
	})
	useMountEffect(() => {
		// react-doctor-disable-next-line react-doctor/rules-of-hooks -- React Doctor does not recognize useMountEffect as an Effect Event boundary.
		const listener = (event: MessageEvent) => handleMessage(event)
		window.addEventListener("message", listener)
		return () => window.removeEventListener("message", listener)
	})
}

function CloudflareConnectBoundary({ children }: { children: React.ReactNode }) {
	const refreshStatus = useAtomRefresh(
		retainedQuery("integrations", "cloudflareStatus", {
			reactivityKeys: ["cloudflareIntegrationStatus"],
		}),
	)
	const refreshUsage = useAtomRefresh(
		retainedQuery("integrations", "cloudflareUsage", {
			reactivityKeys: ["cloudflareIntegrationUsage"],
		}),
	)
	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "cloudflareStart"), {
		mode: "promiseExit",
	})
	const primeConnection = useAtomSet(MapleApiAtomClient.mutation("integrations", "cloudflarePrime"), {
		mode: "promiseExit",
	})
	// Whether this attempt's prime already ran against a live grant. A prime that lands before the
	// callback committed reports `connected: false` and leaves the flag down, so the next signal of
	// the same attempt retries it rather than assuming the work was done.
	const primedRef = useRef(false)

	/**
	 * Discover zones and Workers now instead of on the alerting cron's next five-minute tick. The
	 * API used to do this inside the OAuth callback, which held the popup blank for the whole poll;
	 * running it from here keeps the popup's job to "authorize and close" and puts the wait under
	 * the card's own "finding your zones" banner, where it is explained and self-updating.
	 */
	const primeIntegration = useEffectEvent(async () => {
		if (primedRef.current) return
		primedRef.current = true
		const result = await primeConnection({
			reactivityKeys: ["cloudflareIntegrationStatus", "cloudflareIntegrationUsage"],
		})
		primedRef.current = Exit.isSuccess(result) && result.value.connected
		refreshStatus()
		refreshUsage()
	})

	useIntegrationMessage("maple:integration:cloudflare", (data) => {
		if (data.status === "success") {
			toastManager.add({ title: "Cloudflare account connected", type: "success" })
			void primeIntegration()
		} else if (data.status === "error") {
			toastManager.add({ title: data.message ?? "Cloudflare connection failed", type: "error" })
			// The message is not proof of what was persisted — a replayed callback reports a
			// consumed state as an error over a grant that landed. Re-read rather than guess.
			refreshStatus()
		}
	})

	const value = useOAuthPopupFlow({
		windowName: "maple-cloudflare-connect",
		windowFeatures: "popup,width=520,height=680",
		label: "Cloudflare",
		start: () => {
			primedRef.current = false
			return startConnect({
				payload: new CloudflareStartConnectRequest({ returnTo: window.location.href }),
				reactivityKeys: ["cloudflareIntegrationStatus"],
			})
		},
		startErrorTitle: "Failed to start Cloudflare connect flow",
		onClosed: () => {
			refreshStatus()
			refreshUsage()
			// Also prime here: a lost postMessage (or a popup the user closed on the success page)
			// must not be the difference between an integration that fills in and one that looks
			// like connecting did nothing. No-ops server-side when no grant landed.
			void primeIntegration()
		},
		onPoll: refreshStatus,
		// Keep polling past the close so a grant committed at the last moment still lands in view.
		closeGraceMs: 15_000,
	})

	return <IntegrationConnectContext value={value}>{children}</IntegrationConnectContext>
}

function HazelConnectBoundary({ children }: { children: React.ReactNode }) {
	const refreshStatus = useAtomRefresh(
		retainedQuery("integrations", "hazelStatus", {
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
		label: "Hazel",
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
		retainedQuery("integrations", "githubStatus", {
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
		label: "GitHub",
		windowFeatures: "popup,width=600,height=720",
		start: () =>
			startConnect({
				payload: new GithubStartConnectRequest({ returnTo: window.location.href }),
				reactivityKeys: ["githubIntegrationStatus"],
			}),
		startErrorTitle: "Failed to start GitHub connect flow",
		onClosed: refreshStatus,
		// Keep polling through the server-side repository backfill enqueue gap.
		closeGraceMs: 10_000,
	})

	return <IntegrationConnectContext value={value}>{children}</IntegrationConnectContext>
}

function PlanetscaleConnectBoundary({ children }: { children: React.ReactNode }) {
	const refreshStatus = useAtomRefresh(
		retainedQueryV2("planetscaleIntegration", "status", {
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
		label: "PlanetScale",
		windowFeatures: "popup,width=520,height=680",
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
