import { useEffect, useState } from "react"
import { Exit } from "effect"
import { CloudflareStartConnectRequest } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { toast } from "sonner"

import { CloudflareIcon, LoaderIcon } from "@/components/icons"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { CLOUDFLARE_ACCENT, IntegrationIconPlate } from "./integration-catalog"

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

	if (!isConnected) {
		return (
			<div className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4">
				<IntegrationIconPlate icon={CloudflareIcon} accent={CLOUDFLARE_ACCENT} />

				<div className="flex flex-1 flex-col gap-2">
					<div>
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">Cloudflare account</h3>
							<Badge variant="outline">Not connected</Badge>
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							Authorize Maple against your Cloudflare account via OAuth. This is the foundation
							for one-click telemetry setup — upcoming: auto-provisioned Workers traces & logs
							and Logpush jobs, no manual dashboard configuration.
						</p>
					</div>

					<div>
						<Button onClick={handleConnect} disabled={busy !== null}>
							{busy === "connect" ? (
								<LoaderIcon size={16} className="animate-spin" />
							) : (
								<CloudflareIcon size={16} />
							)}
							Connect Cloudflare
						</Button>
					</div>
				</div>
			</div>
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
