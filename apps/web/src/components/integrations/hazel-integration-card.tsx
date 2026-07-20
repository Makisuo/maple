import { useState } from "react"
import { Exit, Option } from "effect"
import { HazelStartConnectRequest } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toast } from "sonner"

import { ErrorState } from "@/components/common/error-state"
import { BellIcon, ConnectionIcon, HazelIcon, LoaderIcon, ShieldIcon } from "@/components/icons"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { HAZEL_ACCENT, IntegrationIconPlate } from "./integration-catalog"
import { IntegrationEmptyState } from "./integration-empty-state"

export function HazelIntegrationCard() {
	const statusAtom = MapleApiAtomClient.query("integrations", "hazelStatus", {
		reactivityKeys: ["hazelIntegrationStatus"],
	})
	const statusResult = useAtomValue(statusAtom)
	const refreshStatus = useAtomRefresh(statusAtom)

	const startConnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "hazelStart"), {
		mode: "promiseExit",
	})
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "hazelDisconnect"), {
		mode: "promiseExit",
	})

	const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null)

	useMountEffect(() => {
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
	})

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() =>
			Result.isFailure(statusResult)
				? Option.getOrNull(Option.map(statusResult.previousSuccess, (previous) => previous.value))
				: null,
		)
	const isLoading = Result.isInitial(statusResult) && status === null
	const loadFailed = Result.isFailure(statusResult) && status === null

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
	if (isLoading) {
		return <Skeleton className="h-32 w-full rounded-lg" />
	}
	if (loadFailed) {
		return (
			<ErrorState
				error={statusResult.cause}
				title="Failed to load the Hazel integration"
				onRetry={refreshStatus}
			/>
		)
	}

	if (!isConnected) {
		return (
			<IntegrationEmptyState
				icon={HazelIcon}
				accent={HAZEL_ACCENT}
				title="Connect Hazel"
				description="Forward Maple alerts into a Hazel workspace via OAuth. Once connected, create a Hazel destination to pick which workspace receives notifications."
				features={[
					{
						icon: BellIcon,
						title: "Alert delivery",
						description: "Fired alerts post straight into a Hazel channel.",
					},
					{
						icon: ConnectionIcon,
						title: "Channel routing",
						description: "Each destination picks the workspace and channel that gets notified.",
					},
					{
						icon: ShieldIcon,
						title: "Escalations",
						description: "Use Hazel as a step in escalation policies.",
					},
				]}
				footer="You'll authorize Maple in your Hazel workspace."
			>
				<Button onClick={handleConnect} disabled={busy !== null}>
					{busy === "connect" ? (
						<LoaderIcon size={16} className="animate-spin" />
					) : (
						<HazelIcon size={16} />
					)}
					Connect Hazel
				</Button>
			</IntegrationEmptyState>
		)
	}

	return (
		<div className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4">
			<IntegrationIconPlate icon={HazelIcon} accent={HAZEL_ACCENT} />

			<div className="flex flex-1 flex-col gap-2">
				<div>
					<div className="flex items-center gap-2">
						<h3 className="text-sm font-semibold">Hazel</h3>
						<Badge variant="success">Connected</Badge>
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						Forward Maple alerts into a Hazel workspace via OAuth. Once connected, create a Hazel
						destination to pick which workspace receives notifications.
					</p>
				</div>

				{status ? (
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
