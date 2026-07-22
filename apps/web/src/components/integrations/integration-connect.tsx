import { createContext, use, useEffect, useRef, useState } from "react"
import type React from "react"
import { Cause, Exit } from "effect"
import {
	CloudflareStartConnectRequest,
	GithubStartConnectRequest,
	HazelStartConnectRequest,
	PlanetScaleStartConnectRequest,
} from "@maple/domain/http"
import { toast } from "sonner"

import { useAtomRefresh, useAtomSet } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
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

/** Best-effort human message from a failed mutation Exit (tagged API errors carry one). */
function extractErrorMessage(result: Exit.Exit<unknown, unknown>): string | null {
	if (Exit.isSuccess(result)) return null
	const first = Cause.prettyErrors(result.cause)[0]
	if (first?.message) return first.message
	return null
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
	startErrorMessage,
	onClosed,
	closeGraceMs = 0,
}: {
	windowName: string
	windowFeatures: string
	start: () => Promise<Exit.Exit<{ readonly redirectUrl: string }, unknown>>
	startErrorMessage: (result: Exit.Exit<{ readonly redirectUrl: string }, unknown>) => string
	onClosed: () => void
	/** Keeps `popupActive` true for this long after close (GitHub's backfill-enqueue gap). */
	closeGraceMs?: number
}): IntegrationConnect {
	const [busy, setBusy] = useState(false)
	const popupRef = useRef<Window | null>(null)
	const [popupOpen, setPopupOpen] = useState(false)
	const [inCloseGrace, setInCloseGrace] = useState(false)

	useEffect(() => {
		if (!popupOpen) return
		const id = setInterval(() => {
			if (popupRef.current?.closed ?? true) {
				popupRef.current = null
				setPopupOpen(false)
				if (closeGraceMs > 0) setInCloseGrace(true)
				onClosed()
			}
		}, 500)
		return () => clearInterval(id)
	}, [popupOpen, closeGraceMs, onClosed])

	useEffect(() => {
		if (!inCloseGrace) return
		const id = setTimeout(() => setInCloseGrace(false), closeGraceMs)
		return () => clearTimeout(id)
	}, [inCloseGrace, closeGraceMs])

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
			toast.error(startErrorMessage(result))
		}
	}

	return { connect: () => void connect(), busy, popupActive: popupOpen || inCloseGrace }
}

/** The OAuth popup returns to this same SPA and posts a message before closing. */
function useIntegrationMessage(
	type: string,
	onMessage: (data: { status?: string; message?: string }) => void,
) {
	// Ref'd so the listener registers once but always sees the latest handler.
	const handlerRef = useRef(onMessage)
	handlerRef.current = onMessage
	useEffect(() => {
		function listener(event: MessageEvent) {
			if (event.data?.type === type) handlerRef.current(event.data)
		}
		window.addEventListener("message", listener)
		return () => window.removeEventListener("message", listener)
	}, [type])
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
			toast.success("Cloudflare account connected")
			refreshStatus()
			refreshUsage()
		} else if (data.status === "error") {
			toast.error(data.message ?? "Cloudflare connection failed")
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
		startErrorMessage: () => "Failed to start Cloudflare connect flow",
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
			toast.success("Hazel connected")
			refreshStatus()
		} else if (data.status === "error") {
			toast.error(data.message ?? "Hazel connection failed")
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
		startErrorMessage: () => "Failed to start Hazel connect flow",
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
			toast.success("GitHub connected")
			refreshStatus()
		} else if (data.status === "error") {
			toast.error(data.message ?? "GitHub connection failed")
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
		startErrorMessage: () => "Failed to start GitHub connect flow",
		onClosed: refreshStatus,
		// Repos backfill server-side after install with no push channel — keep the
		// card's status polling alive through the enqueue gap after the popup closes.
		closeGraceMs: 10_000,
	})

	return <IntegrationConnectContext value={value}>{children}</IntegrationConnectContext>
}

function PlanetscaleConnectBoundary({ children }: { children: React.ReactNode }) {
	const refreshStatus = useAtomRefresh(
		MapleApiAtomClient.query("integrations", "planetscaleStatus", {
			reactivityKeys: ["planetscaleIntegrationStatus"],
		}),
	)
	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "planetscaleStart"), {
		mode: "promiseExit",
	})

	useIntegrationMessage("maple:integration:planetscale", (data) => {
		if (data.status === "success") {
			refreshStatus()
		} else if (data.status === "error") {
			toast.error(data.message ?? "PlanetScale connection failed")
		}
	})

	const value = useOAuthPopupFlow({
		windowName: "maple-planetscale-connect",
		windowFeatures: "popup,width=520,height=680",
		start: () =>
			startConnect({
				payload: new PlanetScaleStartConnectRequest({ returnTo: window.location.href }),
				reactivityKeys: ["planetscaleIntegrationStatus"],
			}),
		startErrorMessage: (result) =>
			extractErrorMessage(result) ?? "Failed to start PlanetScale connect flow",
		onClosed: refreshStatus,
	})

	return <IntegrationConnectContext value={value}>{children}</IntegrationConnectContext>
}
