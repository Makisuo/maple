import { useEffect, useState } from "react"
import { Exit } from "effect"
import { CloudflareStartConnectRequest } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toast } from "sonner"

import { CloudflareIcon, LoaderIcon } from "@/components/icons"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { formatRelativeTime } from "@/lib/format"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { CLOUDFLARE_ACCENT, IntegrationIconPlate } from "./integration-catalog"
import { IntegrationEmptyState } from "./integration-empty-state"

function CollectionStatusRow(props: {
	name: string
	enabled: boolean
	lastSyncedAt: number | null
	lastError: string | null
}) {
	const dotClass = !props.enabled
		? "bg-muted-foreground/40"
		: props.lastError
			? "bg-destructive"
			: props.lastSyncedAt
				? "bg-emerald-500"
				: "bg-amber-500"
	const detail = !props.enabled
		? "disabled"
		: (props.lastError ??
			(props.lastSyncedAt
				? `synced ${formatRelativeTime(new Date(props.lastSyncedAt).toISOString())}`
				: "waiting for first sync"))
	return (
		<div className="flex items-center gap-2" title={props.lastError ?? undefined}>
			<span className={`size-1.5 shrink-0 rounded-full ${dotClass}`} />
			<span className="truncate text-foreground">{props.name}</span>
			<span className="ml-auto shrink-0 truncate text-muted-foreground" style={{ maxWidth: "55%" }}>
				{detail}
			</span>
		</div>
	)
}

/**
 * Account-level Cloudflare OAuth connection (Authorization Code + PKCE). Distinct from the
 * Logpush connectors below it on the page: this authorizes Maple against the customer's
 * Cloudflare account so later phases can auto-provision telemetry (Workers traces/logs,
 * Logpush jobs) instead of the manual copy-paste setup.
 */
export function CloudflareAccountCard() {
	const statusResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "cloudflareStatus", {
			reactivityKeys: ["cloudflareIntegrationStatus"],
		}),
	)

	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "cloudflareStart"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "cloudflareDisconnect"), {
		mode: "promiseExit",
	})

	const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null)

	useEffect(() => {
		function onMessage(event: MessageEvent) {
			if (event.data?.type === "maple:integration:cloudflare") {
				if (event.data.status === "success") {
					toast.success("Cloudflare account connected")
				} else if (event.data.status === "error") {
					toast.error(event.data.message ?? "Cloudflare connection failed")
				}
			}
		}
		window.addEventListener("message", onMessage)
		return () => window.removeEventListener("message", onMessage)
	}, [])

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() => null)

	async function handleConnect() {
		// Open the popup synchronously (inside the click) so the browser doesn't block it,
		// then point it at the authorize URL once the start call returns.
		const popup = window.open("", "maple-cloudflare-connect", "popup,width=520,height=680")
		setBusy("connect")
		const result = await startConnect({
			payload: new CloudflareStartConnectRequest({ returnTo: window.location.href }),
			reactivityKeys: ["cloudflareIntegrationStatus"],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			const url = result.value.redirectUrl
			if (popup) popup.location.href = url
			else window.open(url, "maple-cloudflare-connect", "popup,width=520,height=680")
		} else {
			popup?.close()
			toast.error("Failed to start Cloudflare connect flow")
		}
	}

	async function handleDisconnect() {
		setBusy("disconnect")
		const result = await disconnect({
			reactivityKeys: ["cloudflareIntegrationStatus"],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			toast.success("Cloudflare account disconnected")
		} else {
			toast.error("Failed to disconnect Cloudflare account")
		}
	}

	const isConnected = status?.connected === true

	// Guard the first fetch so a connected org doesn't flash the "Connect" empty state.
	if (Result.isInitial(statusResult)) {
		return <Skeleton className="h-40 w-full rounded-lg" />
	}

	if (!isConnected) {
		return (
			<IntegrationEmptyState
				icon={CloudflareIcon}
				accent={CLOUDFLARE_ACCENT}
				title="Connect your Cloudflare account"
				description="Authorize Maple with your Cloudflare account via OAuth — the foundation for one-click telemetry. Upcoming phases auto-provision Workers traces & logs and Logpush jobs, with no manual dashboard setup."
				footer="You'll authorize Maple in a Cloudflare popup."
			>
				<Button onClick={handleConnect} disabled={busy !== null}>
					{busy === "connect" ? (
						<LoaderIcon size={16} className="animate-spin" />
					) : (
						<CloudflareIcon size={16} />
					)}
					Connect Cloudflare
				</Button>
			</IntegrationEmptyState>
		)
	}

	return (
		<div className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4">
			<IntegrationIconPlate icon={CloudflareIcon} accent={CLOUDFLARE_ACCENT} />

			<div className="flex flex-1 flex-col gap-2">
				<div>
					<div className="flex items-center gap-2">
						<h3 className="text-sm font-semibold">Cloudflare account</h3>
						<Badge variant="success">Connected</Badge>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						Maple is authorized against this Cloudflare account. Upcoming phases use it to
						auto-provision Workers traces & logs and Logpush jobs.
					</p>
				</div>

				{status ? (
					<div className="flex flex-col gap-1 rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
						<div>
							Account:{" "}
							<span className="text-foreground">
								{status.accountName ?? status.accountId}
							</span>
							{status.accountName && status.accountId ? (
								<span className="ml-1 font-mono text-[10px]">({status.accountId})</span>
							) : null}
						</div>
						{status.scope ? <div>Scopes: {status.scope}</div> : null}
					</div>
				) : null}

				<div className="flex flex-wrap gap-2">
					<Button size="sm" onClick={handleConnect} disabled={busy !== null} variant="outline">
						{busy === "connect" ? <LoaderIcon size={14} className="animate-spin" /> : null}
						Reconnect
					</Button>
					<Button size="sm" onClick={handleDisconnect} disabled={busy !== null} variant="outline">
						{busy === "disconnect" ? <LoaderIcon size={14} className="animate-spin" /> : null}
						Disconnect
					</Button>
				</div>
			</div>
		</div>
	)
}
