import { useEffect, useState } from "react"
import { Exit } from "effect"
import { HazelStartConnectRequest } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { toast } from "sonner"

import { HazelIcon, LoaderIcon } from "@/components/icons"
import { Result, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"

const HAZEL_DOCS_URL = "https://hazel.sh/docs/integrations/maple"

export function IntegrationsSection() {
	return (
		<div className="space-y-4">
			<header className="space-y-1">
				<h2 className="text-lg font-semibold">Integrations</h2>
				<p className="text-sm text-muted-foreground">
					Connect Maple to third-party services so they can act on alerts, incidents, and analytics
					events.
				</p>
			</header>
			<HazelIntegrationCard />
		</div>
	)
}

function HazelIntegrationCard() {
	const statusResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "hazelStatus", {
			reactivityKeys: ["hazelIntegrationStatus"],
		}),
	)

	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "hazelStart"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "hazelDisconnect"), {
		mode: "promiseExit",
	})

	const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null)

	useEffect(() => {
		function onMessage(event: MessageEvent) {
			if (event.data?.type === "maple:integration:hazel") {
				if (event.data.status === "success") {
					toast.success("Hazel connected")
				} else if (event.data.status === "error") {
					toast.error(event.data.message ?? "Hazel connection failed")
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
		const popup = window.open("", "maple-hazel-connect", "popup,width=520,height=640")
		setBusy("connect")
		const result = await startConnect({
			payload: new HazelStartConnectRequest({ returnTo: window.location.href }),
			reactivityKeys: ["hazelIntegrationStatus"],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			const url = result.value.redirectUrl
			if (popup) popup.location.href = url
			else window.open(url, "maple-hazel-connect", "popup,width=520,height=640")
		} else {
			popup?.close()
			toast.error("Failed to start Hazel connect flow")
		}
	}

	async function handleDisconnect() {
		setBusy("disconnect")
		const result = await disconnect({
			reactivityKeys: ["hazelIntegrationStatus", "hazelWorkspaces"],
		})
		setBusy(null)
		if (Exit.isSuccess(result)) {
			toast.success("Hazel disconnected")
		} else {
			toast.error("Failed to disconnect Hazel")
		}
	}

	const isConnected = status?.connected === true

	return (
		<div
			className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4"
			style={{ ["--tile-accent" as string]: "#F46F0F" }}
		>
			<span
				className="relative inline-flex size-12 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card"
				aria-hidden
			>
				<span
					className="absolute inset-0 rounded-lg opacity-70"
					style={{
						background:
							"radial-gradient(circle at 30% 20%, rgba(244,111,15,0.16), transparent 70%)",
					}}
				/>
				<span className="relative" style={{ color: "#F46F0F" }}>
					<HazelIcon size={22} />
				</span>
			</span>

			<div className="flex flex-1 flex-col gap-2">
				<div className="flex items-start justify-between gap-3">
					<div>
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">Hazel</h3>
							{isConnected ? (
								<span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-400">
									Connected
								</span>
							) : (
								<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
									Not connected
								</span>
							)}
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							Forward Maple alerts into a Hazel workspace via OAuth. Once connected, create a
							Hazel destination to pick which workspace receives notifications.
						</p>
					</div>
					<a
						href={HAZEL_DOCS_URL}
						target="_blank"
						rel="noreferrer"
						className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					>
						Docs ↗
					</a>
				</div>

				{isConnected && status ? (
					<div className="flex flex-col gap-1 rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
						{status.externalUserEmail ? (
							<div>
								<span className="text-foreground">{status.externalUserEmail}</span> authorized
								this connection.
							</div>
						) : status.externalUserId ? (
							<div>External account: {status.externalUserId}</div>
						) : null}
						{status.scope ? <div>Scopes: {status.scope}</div> : null}
					</div>
				) : null}

				<div className="flex flex-wrap gap-2">
					{isConnected ? (
						<>
							<Button
								size="sm"
								onClick={handleConnect}
								disabled={busy !== null}
								variant="outline"
							>
								{busy === "connect" ? (
									<LoaderIcon size={14} className="animate-spin" />
								) : null}
								Reconnect
							</Button>
							<Button
								size="sm"
								onClick={handleDisconnect}
								disabled={busy !== null}
								variant="outline"
							>
								{busy === "disconnect" ? (
									<LoaderIcon size={14} className="animate-spin" />
								) : null}
								Disconnect
							</Button>
						</>
					) : (
						<Button
							size="sm"
							onClick={handleConnect}
							disabled={busy !== null}
							style={{ background: "#F46F0F", borderColor: "#F46F0F", color: "#fff" }}
						>
							{busy === "connect" ? <LoaderIcon size={14} className="animate-spin" /> : null}
							Connect Hazel
						</Button>
					)}
				</div>
			</div>
		</div>
	)
}
