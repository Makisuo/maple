import { useState } from "react"
import { Exit, Option } from "effect"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toast } from "sonner"

import { ErrorState } from "@/components/common/error-state"
import { HazelIcon, LoaderIcon } from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { HAZEL_ACCENT, IntegrationIconPlate } from "./integration-catalog"
import { useIntegrationConnect } from "./integration-connect"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"

export function HazelIntegrationCard() {
	const statusAtom = MapleApiAtomClient.query("integrations", "hazelStatus", {
		reactivityKeys: ["hazelIntegrationStatus"],
	})
	const statusResult = useAtomValue(statusAtom)
	const refreshStatus = useAtomRefresh(statusAtom)

	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "hazelDisconnect"), {
		mode: "promiseExit",
	})

	// Connect flow (popup, busy, refresh-on-return) lives in IntegrationConnectProvider —
	// shared with the drill-in header's Connect button.
	const connectFlow = useIntegrationConnect()
	if (connectFlow === null) {
		throw new Error("HazelIntegrationCard must be rendered inside IntegrationConnectProvider")
	}
	const [disconnectBusy, setDisconnectBusy] = useState(false)
	const actionBusy = connectFlow.busy || disconnectBusy

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() =>
			Result.isFailure(statusResult)
				? Option.getOrNull(Option.map(statusResult.previousSuccess, (previous) => previous.value))
				: null,
		)
	const isLoading = Result.isInitial(statusResult) && status === null
	const loadFailed = Result.isFailure(statusResult) && status === null

	async function handleDisconnect() {
		setDisconnectBusy(true)
		const result = await disconnect({
			reactivityKeys: ["hazelIntegrationStatus", "hazelWorkspaces"],
		})
		setDisconnectBusy(false)
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
			<IntegrationEmpty icon={HazelIcon} accent={HAZEL_ACCENT}>
				<IntegrationEmptyFeatures>
					<IntegrationEmptyFeature
						label="Alert delivery"
						title="Alerts post to Hazel"
						description="Fired alerts land straight in the channel you pick."
					/>
					<IntegrationEmptyFeature
						label="Channel routing"
						title="Workspace per destination"
						description="Each destination picks the workspace and channel that gets notified."
					/>
					<IntegrationEmptyFeature
						label="Escalations"
						title="A step in your policies"
						description="Use Hazel as a delivery step inside escalation chains."
					/>
				</IntegrationEmptyFeatures>
				<IntegrationEmptyCard>
					<IntegrationEmptyMedia />
					<IntegrationEmptyHint>
						Alert destinations will appear here after connecting your workspace.
					</IntegrationEmptyHint>
					<Button onClick={connectFlow.connect} disabled={actionBusy}>
						{connectFlow.busy ? (
							<LoaderIcon size={16} className="animate-spin" />
						) : (
							<HazelIcon size={16} />
						)}
						Connect Hazel
					</Button>
					<IntegrationEmptyFooter>
						You'll authorize Maple in your Hazel workspace.
					</IntegrationEmptyFooter>
				</IntegrationEmptyCard>
			</IntegrationEmpty>
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
					<Button size="sm" onClick={connectFlow.connect} disabled={actionBusy} variant="outline">
						{connectFlow.busy ? <LoaderIcon size={14} className="animate-spin" /> : null}
						Reconnect
					</Button>
					<Button size="sm" onClick={handleDisconnect} disabled={actionBusy} variant="outline">
						{disconnectBusy ? <LoaderIcon size={14} className="animate-spin" /> : null}
						Disconnect
					</Button>
				</div>
			</div>
		</div>
	)
}
