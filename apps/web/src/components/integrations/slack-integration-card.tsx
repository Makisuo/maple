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
import { LoaderIcon, SlackIcon, SlackMonoIcon } from "@/components/icons"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { MapleApiV2AtomClient } from "@/lib/services/common/v2-atom-client"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"
import { formatRelativeTime } from "@maple/ui/time-format"
import { getExitErrorMessage } from "@/lib/alerts/form-utils"
import { IntegrationIconPlate, SLACK_ACCENT } from "./integration-catalog"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"

/** Absolute install time for the relative label's `title` tooltip. */
const absoluteDateTime = (value: string): string =>
	new Date(value).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	})

/**
 * What happened on Slack's side, per `disconnected_reason`. Written around the
 * workspace ("Acme") so the sentence composes as "…the {what} the Acme Slack
 * workspace" / "…the {what} your Slack workspace" when the name is unknown.
 */
const remoteDisconnectDetail = (reason: string, teamName: string | null): string => {
	const workspace = teamName ? `the ${teamName} Slack workspace` : "your Slack workspace"
	switch (reason) {
		case "app_uninstalled":
			return `The Maple app was removed from ${workspace}.`
		case "tokens_revoked":
			return `The Maple app's access to ${workspace} was revoked.`
		default:
			// "reconciliation" — Maple's periodic check found the token dead without
			// ever receiving an uninstall event.
			return `Maple's access to ${workspace} is no longer valid.`
	}
}

/**
 * Shown above the install empty state when the previous installation was
 * disconnected in Slack (app removed / tokens revoked) rather than from this
 * dashboard — without it the card silently reverts to the never-installed state
 * and the disconnect looks like a Maple bug.
 */
function RemoteDisconnectNotice({
	reason,
	teamName,
	disconnectedAt,
}: {
	reason: string
	teamName: string | null
	disconnectedAt: string | null
}) {
	return (
		<div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
			<span className="font-medium text-foreground">Slack is no longer connected.</span>{" "}
			{remoteDisconnectDetail(reason, teamName)}
			{disconnectedAt ? (
				<span title={absoluteDateTime(disconnectedAt)}>
					{" "}
					Disconnected {formatRelativeTime(disconnectedAt)}.
				</span>
			) : null}{" "}
			Alert rules with Slack destinations have stopped delivering — add Maple to Slack again to
			reconnect.
		</div>
	)
}

/**
 * Skeleton for the first status fetch. Models the not-installed resolution — the
 * common first-run outcome — so the card doesn't jump several hundred pixels
 * when status lands: three feature tiles above the dashed waiting-room card.
 */
function LoadingState() {
	return (
		<div className="flex flex-col gap-4">
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
				{[0, 1, 2].map((index) => (
					<div
						key={index}
						className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card px-4 py-3.5"
					>
						<Skeleton className="h-3 w-20" />
						<Skeleton className="h-4 w-32" />
						<Skeleton className="h-3 w-full" />
					</div>
				))}
			</div>
			<div className="flex min-h-70 flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-input px-6 py-10">
				<Skeleton className="size-14 rounded-xl" />
				<Skeleton className="h-4 w-72 max-w-full" />
				<Skeleton className="h-9 w-36 rounded-md" />
				<Skeleton className="h-3 w-56 max-w-full" />
			</div>
		</div>
	)
}

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

	// Same gate the API applies (and always true on self-hosted, which runs as a
	// single root user).
	const isAdmin = useIsOrgAdmin()
	// `useIsOrgAdmin` reports false until the session lands, so the admin-only copy
	// would briefly tell an admin they aren't one. The controls still stay disabled
	// while unknown — only the explanation waits for a settled session.
	const sessionResult = useAtomValue(MapleApiAtomClient.query("auth", "session", {}))
	const adminKnown = !isClerkAuthEnabled || !Result.isInitial(sessionResult)
	const showNotAdmin = adminKnown && !isAdmin

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

	// Shared by "Add to Slack", "Reconnect", and "Update permissions": a
	// reconnect is the same OAuth install run over the existing installation —
	// the backend updates the workspace row in place, so the bot keeps its
	// channel memberships (unlike disconnect + reinstall).
	async function handleInstall() {
		setBusy("install")
		const result = await install({ reactivityKeys: ["slackIntegration"] })
		if (Exit.isSuccess(result)) {
			// Full-page redirect to Slack's consent screen; the callback returns the
			// browser to /integrations?slack=connected (or slack=updated on a re-auth).
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
		return <LoadingState />
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
			<IntegrationEmpty icon={SlackIcon} backerIcon={SlackMonoIcon} accent={SLACK_ACCENT}>
				{status?.disconnected_reason ? (
					<RemoteDisconnectNotice
						reason={status.disconnected_reason}
						teamName={status.disconnected_team_name}
						disconnectedAt={status.disconnected_at}
					/>
				) : null}
				<IntegrationEmptyFeatures>
					<IntegrationEmptyFeature
						label="Ask Maple"
						title="Query and act from Slack"
						description="Mention the bot to query services, traces, and errors, or create dashboards and other resources."
					/>
					<IntegrationEmptyFeature
						label="Alert delivery"
						title="Alerts post to channels"
						description="Route alert rules to any channel the bot can post to."
					/>
					<IntegrationEmptyFeature
						label="Channel routing"
						title="Channel per destination"
						description="Each alert destination picks the channel that gets notified."
					/>
				</IntegrationEmptyFeatures>
				<IntegrationEmptyCard>
					<IntegrationEmptyMedia />
					<IntegrationEmptyHint>
						Slack destinations will appear here after you add Maple to your workspace.
					</IntegrationEmptyHint>
					<Button onClick={handleInstall} disabled={!isAdmin || busy !== null}>
						{busy === "install" ? (
							<LoaderIcon size={16} className="animate-spin" />
						) : (
							// Monochrome inside the filled primary button, like every sibling
							// CTA mark — the swap to the loader then reads as motion, not color.
							<SlackIcon size={16} monochrome />
						)}
						Add to Slack
					</Button>
					<IntegrationEmptyFooter>
						{showNotAdmin
							? "Only organization admins can install the Slack app."
							: "You'll approve the install in your Slack workspace."}
					</IntegrationEmptyFooter>
				</IntegrationEmptyCard>
			</IntegrationEmpty>
		)
	}

	const missingScopes = status?.missing_scopes ?? []
	const needsReauth = missingScopes.length > 0

	return (
		<>
			{needsReauth ? (
				<div className="mb-4 flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
					<div>
						<span className="font-medium text-foreground">
							Maple needs additional Slack permissions.
						</span>{" "}
						This installation predates permissions Maple now relies on (
						<span className="font-mono">{missingScopes.join(", ")}</span>). Updating re-runs the
						Slack approval — the bot stays in its channels and alert destinations keep working.
					</div>
					<div>
						<Button size="sm" onClick={handleInstall} disabled={!isAdmin || busy !== null}>
							{busy === "install" ? <LoaderIcon size={14} className="animate-spin" /> : null}
							Update permissions
						</Button>
					</div>
				</div>
			) : null}
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
							The Maple bot answers questions, creates dashboards and other resources on
							request, and delivers alerts to channels. Create a Slack (bot) destination on an
							alert rule to route notifications.
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
								// Relative, like every other integrations surface; the absolute
								// timestamp stays available on hover.
								<div title={absoluteDateTime(status.installed_at)}>
									Installed {formatRelativeTime(status.installed_at)}
								</div>
							) : null}
						</div>
					) : null}

					<div className="flex flex-wrap gap-2">
						{/* Hidden while the drift banner shows its "Update permissions"
						    button — both run the same OAuth re-install, and two identical
						    affordances would compete. */}
						{!needsReauth ? (
							<Button
								size="sm"
								onClick={handleInstall}
								disabled={!isAdmin || busy !== null}
								variant="outline"
							>
								{busy === "install" ? (
									<LoaderIcon size={14} className="animate-spin" />
								) : null}
								Reconnect
							</Button>
						) : null}
						{/* No spinner here: the confirm dialog stays open for the whole
						    uninstall, so its own action button carries the busy state. */}
						<Button
							size="sm"
							onClick={() => setConfirmOpen(true)}
							disabled={!isAdmin || busy !== null}
							variant="outline"
						>
							Disconnect
						</Button>
					</div>
					{showNotAdmin ? (
						<p className="text-[11px] text-muted-foreground">
							Only organization admins can reconnect or disconnect the Slack app.
						</p>
					) : (
						<p className="text-[11px] text-muted-foreground">
							Reconnect re-runs the Slack approval in place — use it to refresh the connection
							or grant new permissions without removing the bot from its channels.
						</p>
					)}
				</div>
			</div>

			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Disconnect Slack</AlertDialogTitle>
						<AlertDialogDescription>
							This uninstalls the Maple Slack app, revokes the API key minted for the bot, and
							removes the bot from every channel it was invited to. Alert rules using Slack
							(bot) destinations will stop delivering, and after a reinstall the bot must be
							re-invited to private channels. To refresh the connection or grant new
							permissions, use Reconnect instead — it keeps channel memberships.
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
