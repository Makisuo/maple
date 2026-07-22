import { useState } from "react"
import { Exit, Option } from "effect"

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@maple/ui/components/ui/alert-dialog"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toast } from "sonner"

import { ErrorState } from "@/components/common/error-state"
import {
	BellIcon,
	ChatBubbleSparkleIcon,
	ConnectionIcon,
	LoaderIcon,
	SlackIcon,
} from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { formatAlertDateTime, getExitErrorMessage } from "@/lib/alerts/form-utils"
import { IntegrationIconPlate, SLACK_ACCENT } from "./integration-catalog"
import { IntegrationEmptyState } from "./integration-empty-state"

/**
 * First-class Slack connection card: install the Maple Slack app via OAuth (a
 * full-page redirect to Slack's consent screen; on approval Slack redirects back
 * to `/integrations?slack=connected`). Once installed, the bot answers Maple
 * questions in Slack and alert rules can post to channels via a `slack-bot`
 * destination. Install/uninstall are org-admin only — the backend also enforces
 * this, so a non-admin only ever sees a disabled affordance.
 */
export function SlackIntegrationCard() {
	const statusAtom = MapleApiV2AtomClient.query("slackIntegration", "status", {
		reactivityKeys: ["slackIntegration"],
	})
	const statusResult = useAtomValue(statusAtom)
	const refreshStatus = useAtomRefresh(statusAtom)

	const sessionResult = useAtomValue(MapleApiAtomClient.query("auth", "session", {}))
	const isAdmin = Result.builder(sessionResult)
		.onSuccess((session) => session.roles.some((role) => role === "root" || role === "org:admin"))
		.orElse(() => false)

	const install = useAtomSet(MapleApiV2AtomClient.mutation("slackIntegration", "install"), {
		mode: "promiseExit",
	})
	const uninstall = useAtomSet(MapleApiV2AtomClient.mutation("slackIntegration", "uninstall"), {
		mode: "promiseExit",
	})

	const [busy, setBusy] = useState<"install" | "uninstall" | null>(null)
	const [confirmOpen, setConfirmOpen] = useState(false)

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() =>
			Result.isFailure(statusResult)
				? Option.getOrNull(Option.map(statusResult.previousSuccess, (previous) => previous.value))
				: null,
		)
	const isLoading = Result.isInitial(statusResult) && status === null
	const loadFailed = Result.isFailure(statusResult) && status === null

	async function handleInstall() {
		setBusy("install")
		const result = await install({ reactivityKeys: ["slackIntegration"] })
		if (Exit.isSuccess(result)) {
			// Full-page redirect to Slack's consent screen; the callback returns the
			// browser to /integrations?slack=connected.
			window.location.href = result.value.url
			return
		}
		setBusy(null)
		toast.error(getExitErrorMessage(result, "Failed to start the Slack install"))
	}

	async function handleUninstall() {
		setBusy("uninstall")
		const result = await uninstall({ reactivityKeys: ["slackIntegration"] })
		setBusy(null)
		setConfirmOpen(false)
		if (Exit.isSuccess(result)) {
			toast.success("Slack disconnected")
		} else {
			toast.error(getExitErrorMessage(result, "Failed to disconnect Slack"))
		}
	}

	if (isLoading) {
		return <Skeleton className="h-32 w-full rounded-lg" />
	}
	if (loadFailed) {
		return (
			<ErrorState
				error={statusResult.cause}
				title="Failed to load the Slack integration"
				onRetry={refreshStatus}
			/>
		)
	}

	const isInstalled = status?.installed === true

	if (!isInstalled) {
		return (
			<IntegrationEmptyState
				icon={SlackIcon}
				accent={SLACK_ACCENT}
				title="Add Maple to Slack"
				description="Install the Maple Slack app so your team can ask Maple about services, traces, and errors from Slack — and route fired alerts into channels."
				features={[
					{
						icon: ChatBubbleSparkleIcon,
						title: "Ask Maple",
						description: "Mention the bot to query services, traces, and errors from Slack.",
					},
					{
						icon: BellIcon,
						title: "Alert delivery",
						description: "Route alert rules to any channel the bot can post to.",
					},
					{
						icon: ConnectionIcon,
						title: "Channel routing",
						description: "Each alert destination picks the channel that gets notified.",
					},
				]}
				footer={
					isAdmin
						? "You'll approve the install in your Slack workspace."
						: "Only organization admins can install the Slack app."
				}
			>
				<Button onClick={handleInstall} disabled={!isAdmin || busy !== null}>
					{busy === "install" ? (
						<LoaderIcon size={16} className="animate-spin" />
					) : (
						<SlackIcon size={16} />
					)}
					Add to Slack
				</Button>
			</IntegrationEmptyState>
		)
	}

	return (
		<>
			<div className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4">
				<IntegrationIconPlate icon={SlackIcon} accent={SLACK_ACCENT} />

				<div className="flex flex-1 flex-col gap-2">
					<div>
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">Slack</h3>
							<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
								Connected
							</span>
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							The Maple bot answers questions in Slack and delivers alerts to channels. Create a
							Slack (bot) destination on an alert rule to route notifications.
						</p>
					</div>

					{status?.team_name || status?.installed_at ? (
						<div className="flex flex-col gap-1 border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
							{status?.team_name ? (
								<div>
									Workspace: <span className="text-foreground">{status.team_name}</span>
								</div>
							) : null}
							{status?.installed_at ? (
								<div>Installed {formatAlertDateTime(status.installed_at)}</div>
							) : null}
						</div>
					) : null}

					<div className="flex flex-wrap gap-2">
						<Button
							size="sm"
							onClick={() => setConfirmOpen(true)}
							disabled={!isAdmin || busy !== null}
							variant="outline"
						>
							{busy === "uninstall" ? <LoaderIcon size={14} className="animate-spin" /> : null}
							Disconnect
						</Button>
					</div>
					{!isAdmin ? (
						<p className="text-[11px] text-muted-foreground">
							Only organization admins can disconnect the Slack app.
						</p>
					) : null}
				</div>
			</div>

			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Disconnect Slack</AlertDialogTitle>
						<AlertDialogDescription>
							This uninstalls the Maple Slack app and revokes the API key minted for the bot. Alert
							rules using Slack (bot) destinations will stop delivering to Slack. You can reinstall
							at any time.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={handleUninstall}
							disabled={busy !== null}
						>
							{busy === "uninstall" ? <LoaderIcon size={14} className="animate-spin" /> : null}
							Disconnect
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
