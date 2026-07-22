import { useEffect, useState } from "react"
import { Exit, Option } from "effect"
import {
	GithubSetTrackedBranchRequest,
	type GithubIntegrationStatus,
	type GithubRepoSummary,
	type VcsRepoSyncStatus,
} from "@maple/domain/http"
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
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@maple/ui/components/ui/popover"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { toast } from "sonner"

import {
	ArrowRotateClockwiseIcon,
	CheckIcon,
	ChevronDownIcon,
	CircleCheckIcon,
	CircleWarningIcon,
	ClockIcon,
	ExternalLinkIcon,
	GithubIcon,
	LoaderIcon,
	TrashIcon,
} from "@/components/icons"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { GITHUB_ACCENT, IntegrationIconPlate } from "./integration-catalog"
import { useIntegrationConnect, type IntegrationConnect } from "./integration-connect"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"

/** How often to re-fetch status while the connect flow / background sync is active. */
const POLL_INTERVAL_MS = 3_000
/**
 * Grace window after an action whose effect isn't yet visible in `status` (popup close,
 * tracked-branch change). Bridges the gap until the repo's sync status takes over polling.
 */
const FORCE_POLL_WINDOW_MS = 10_000

/** Visual presentation for each sync state — leading icon + short label + tone. */
const SYNC_PRESENTATION: Record<
	VcsRepoSyncStatus,
	{ label: string; tone: string; Icon: typeof CircleCheckIcon; spin?: boolean }
> = {
	ready: { label: "Synced", tone: "text-success-foreground", Icon: CircleCheckIcon },
	backfilling: { label: "Syncing", tone: "text-info-foreground", Icon: LoaderIcon, spin: true },
	pending: { label: "Queued", tone: "text-muted-foreground", Icon: ClockIcon },
	error: { label: "Sync failed", tone: "text-destructive-foreground", Icon: CircleWarningIcon },
}

function relativeFromMillis(ms: number): string {
	const diff = Date.now() - ms
	if (diff < 0) return "just now"
	const seconds = Math.floor(diff / 1000)
	if (seconds < 60) return "just now"
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.floor(hours / 24)
	return `${days}d ago`
}

export function GithubIntegrationCard() {
	// Assigned once so the refresh hook targets the same memoized query atom.
	const statusQuery = MapleApiAtomClient.query("integrations", "githubStatus", {
		reactivityKeys: ["githubIntegrationStatus"],
	})
	const statusResult = useAtomValue(statusQuery)
	const refreshStatus = useAtomRefresh(statusQuery)

	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "githubDisconnect"), {
		mode: "promiseExit",
	})
	const deleteRepository = useAtomSet(
		MapleApiAtomClient.mutation("integrations", "githubDeleteRepository"),
		{ mode: "promiseExit" },
	)
	const setTrackedBranch = useAtomSet(
		MapleApiAtomClient.mutation("integrations", "githubSetTrackedBranch"),
		{ mode: "promiseExit" },
	)

	// Connect flow (popup, busy, refresh-on-return, post-close grace window) lives in
	// IntegrationConnectProvider — shared with the drill-in header's Connect button.
	const connectFlow = useIntegrationConnect()
	if (connectFlow === null) {
		throw new Error("GithubIntegrationCard must be rendered inside IntegrationConnectProvider")
	}
	const [disconnectBusy, setDisconnectBusy] = useState(false)
	// Separate from the query's `waiting` flag — only true on an explicit Refresh click, not background polls.
	const [refreshing, setRefreshing] = useState(false)
	// Repo awaiting delete confirmation; id of the repo currently being deleted (shows spinner).
	const [repoToDelete, setRepoToDelete] = useState<GithubRepoSummary | null>(null)
	const [deletingRepoId, setDeletingRepoId] = useState<string | null>(null)
	// Disconnect is a full purge (repos + commit history), so it routes through a confirmation.
	const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)
	const [forcePoll, setForcePoll] = useState(false)

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() =>
			// Keep the last loaded status visible if a refresh/poll fails, so a transient error
			// doesn't blow away the connected view.
			Result.isFailure(statusResult)
				? Option.getOrNull(Option.map(statusResult.previousSuccess, (prev) => prev.value))
				: null,
		)
	const isLoading = Result.isInitial(statusResult) && status === null
	// A genuine load failure with nothing to fall back on — surface a retry instead of silently
	// rendering the first-run "Connect" screen (which is indistinguishable from "never connected").
	const loadFailed = Result.isFailure(statusResult) && status === null

	// Repos backfill in the VcsSyncQueue worker after connect, so status keeps changing
	// server-side with no push channel. Poll while the connect popup is open, for a grace
	// window after it closes, and while any repo is still syncing (self-terminating).
	const syncing =
		status?.connected === true &&
		status.repositories.some((r) => r.syncStatus === "pending" || r.syncStatus === "backfilling")
	// popupActive covers the connect popup plus the provider's post-close grace window.
	const shouldPoll = connectFlow.popupActive || forcePoll || syncing

	useEffect(() => {
		if (!shouldPoll) return
		const id = setInterval(() => refreshStatus(), POLL_INTERVAL_MS)
		return () => clearInterval(id)
	}, [shouldPoll, refreshStatus])

	useEffect(() => {
		if (!forcePoll) return
		const id = setTimeout(() => setForcePoll(false), FORCE_POLL_WINDOW_MS)
		return () => clearTimeout(id)
	}, [forcePoll])

	function handleManualRefresh() {
		refreshStatus()
		// Hold the spinner briefly so a fast refetch is still perceptible.
		setRefreshing(true)
	}

	useEffect(() => {
		if (!refreshing) return
		const id = setTimeout(() => setRefreshing(false), 700)
		return () => clearTimeout(id)
	}, [refreshing])

	async function handleDisconnect() {
		setDisconnectBusy(true)
		const result = await disconnect({ reactivityKeys: ["githubIntegrationStatus"] })
		setDisconnectBusy(false)
		if (Exit.isSuccess(result)) {
			toast.success("GitHub disconnected")
		} else {
			toast.error("Failed to disconnect GitHub")
		}
	}

	async function handleDeleteRepository(repo: GithubRepoSummary) {
		setRepoToDelete(null)
		setDeletingRepoId(repo.id)
		const result = await deleteRepository({
			params: { repositoryId: repo.id },
			reactivityKeys: ["githubIntegrationStatus"],
		})
		setDeletingRepoId(null)
		if (Exit.isSuccess(result)) {
			toast.success(`Deleted ${repo.fullName} from Maple`)
		} else {
			toast.error(`Failed to delete ${repo.fullName}`)
		}
	}

	async function handleSetTrackedBranch(repo: GithubRepoSummary, trackedBranch: string) {
		const result = await setTrackedBranch({
			params: { repositoryId: repo.id },
			payload: new GithubSetTrackedBranchRequest({ trackedBranch }),
			reactivityKeys: ["githubIntegrationStatus"],
		})
		if (Exit.isSuccess(result)) {
			if (result.value.backfillQueued) {
				toast.success(`Now tracking ${trackedBranch} — re-syncing commits…`)
				// Poll through the gap between enqueue and the worker flipping the repo to "backfilling".
				setForcePoll(true)
				refreshStatus()
			}
		} else {
			toast.error("Failed to change tracked branch")
			// Surface failure so the selector can revert its optimistic state.
			throw new Error("Failed to change tracked branch")
		}
	}

	return (
		<>
			{isLoading ? (
				<LoadingState />
			) : loadFailed ? (
				<LoadFailedState onRetry={handleManualRefresh} />
			) : status?.connected ? (
				<ConnectedView
					status={status}
					connectFlow={connectFlow}
					disconnectBusy={disconnectBusy}
					refreshing={refreshing}
					deletingRepoId={deletingRepoId}
					onRefresh={handleManualRefresh}
					onRequestDisconnect={() => setConfirmingDisconnect(true)}
					onRequestDelete={setRepoToDelete}
					onSetTrackedBranch={handleSetTrackedBranch}
				/>
			) : status?.state === "disconnected" || status?.state === "suspended" ? (
				<DeactivatedState status={status} connectFlow={connectFlow} />
			) : (
				<NotConnectedState connectFlow={connectFlow} />
			)}

			<AlertDialog
				open={confirmingDisconnect}
				onOpenChange={(open) => {
					if (!open) setConfirmingDisconnect(false)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Disconnect GitHub</AlertDialogTitle>
						<AlertDialogDescription>
							This removes the Maple GitHub App connection and permanently deletes all synced
							repositories and their commit history from Maple. This cannot be undone. You can
							reconnect later, but everything will be re-synced from scratch.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								setConfirmingDisconnect(false)
								void handleDisconnect()
							}}
						>
							Disconnect
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog
				open={repoToDelete !== null}
				onOpenChange={(open) => {
					if (!open) setRepoToDelete(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete repository from Maple</AlertDialogTitle>
						<AlertDialogDescription>
							This permanently removes{" "}
							<span className="font-medium text-foreground">{repoToDelete?.fullName}</span> and
							all of its synced commits from Maple. This cannot be undone. If you re-enable
							access in GitHub later, the repository will be re-synced from scratch.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								if (repoToDelete) void handleDeleteRepository(repoToDelete)
							}}
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}

/** Skeleton placeholder shown while the first status fetch is in flight. */
function LoadingState() {
	return (
		<div className="space-y-4">
			<Skeleton className="h-16 w-full rounded-lg" />
			<div className="overflow-hidden rounded-lg border">
				<Skeleton className="h-11 w-full rounded-none" />
				<div className="divide-y">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="m-3 h-9 rounded-md" />
					))}
				</div>
			</div>
		</div>
	)
}

/** Shown when the status query fails outright (and there's no prior value to fall back on). */
function LoadFailedState({ onRetry }: { onRetry: () => void }) {
	return (
		<div className="flex flex-col items-center gap-3 py-8 text-center text-sm text-muted-foreground">
			Failed to load the GitHub integration.
			<Button variant="outline" size="sm" onClick={onRetry}>
				Try again
			</Button>
		</div>
	)
}

/** First-run empty state: explains the value and offers the single connect action. */
function NotConnectedState({ connectFlow }: { connectFlow: IntegrationConnect }) {
	return (
		<IntegrationEmpty icon={GithubIcon} accent={GITHUB_ACCENT} iconClassName="text-foreground">
			<IntegrationEmptyFeatures>
				<IntegrationEmptyFeature
					label="Deploy markers"
					title="Commits on service charts"
					description="Metric shifts line up with the deploys that caused them."
				/>
				<IntegrationEmptyFeature
					label="Commit context"
					title="SHAs resolve to authors"
					description="Commit SHAs on traces resolve to message, author, and a GitHub link."
				/>
				<IntegrationEmptyFeature
					label="Org-wide sync"
					title="One tracked branch per repo"
					description="History backfills automatically in the background after install."
				/>
			</IntegrationEmptyFeatures>
			<IntegrationEmptyCard>
				<IntegrationEmptyMedia />
				<IntegrationEmptyHint>
					Your repositories and commits will appear here after installing.
				</IntegrationEmptyHint>
				<Button onClick={connectFlow.connect} disabled={connectFlow.busy}>
					{connectFlow.busy ? (
						<LoaderIcon size={16} className="animate-spin" />
					) : (
						<GithubIcon size={16} />
					)}
					Connect GitHub
				</Button>
				<IntegrationEmptyFooter>
					You'll choose which repositories to share during install.
				</IntegrationEmptyFooter>
			</IntegrationEmptyCard>
		</IntegrationEmpty>
	)
}

/**
 * Shown when the org connected GitHub before but the installation is no longer
 * active — uninstalled / access revoked ("disconnected") or temporarily
 * "suspended" on GitHub's side. The row and its synced data are never auto-deleted,
 * so this state explains *why* the integration went quiet (instead of silently
 * reverting to the first-run screen) and offers a single reconnect action.
 */
function DeactivatedState({
	status,
	connectFlow,
}: {
	status: GithubIntegrationStatus
	connectFlow: IntegrationConnect
}) {
	const { connect: onReconnect, busy } = connectFlow
	const suspended = status.state === "suspended"
	const account = status.accountLogin ? (
		<>
			{" "}
			for <span className="font-medium text-foreground">@{status.accountLogin}</span>
		</>
	) : null
	const repoCount = status.repositories.length

	return (
		<div className="flex flex-col items-center gap-5 rounded-lg border border-warning/40 bg-warning/5 px-6 py-10 text-center">
			<IntegrationIconPlate
				icon={GithubIcon}
				accent={GITHUB_ACCENT}
				iconClassName="text-foreground"
				size={26}
				plateClassName="size-14 rounded-xl"
				overlay={
					<span className="absolute -bottom-1.5 -right-1.5 inline-flex items-center justify-center rounded-full bg-card">
						<CircleWarningIcon size={18} className="text-warning-foreground" />
					</span>
				}
			/>

			<div className="flex max-w-md flex-col gap-1.5">
				<h3 className="text-base font-semibold">
					{suspended ? "GitHub integration suspended" : "GitHub integration deactivated"}
				</h3>
				<p className="text-sm text-muted-foreground">
					{suspended ? (
						<>
							GitHub suspended the Maple GitHub App{account}, so syncing is paused. Reactivate
							it in GitHub, then reconnect to resume.
						</>
					) : (
						<>
							The Maple GitHub App was uninstalled (or its access was revoked) on GitHub
							{account}, so syncing is paused. Reconnect to resume — nothing was deleted.
						</>
					)}
				</p>
			</div>

			{repoCount > 0 ? (
				<p className="text-xs text-muted-foreground">
					{repoCount} {repoCount === 1 ? "repository" : "repositories"} and their commit history are
					preserved.
				</p>
			) : null}

			<div className="flex flex-col items-center gap-2">
				<Button onClick={onReconnect} disabled={busy}>
					{busy ? (
						<LoaderIcon size={16} className="animate-spin" />
					) : (
						<ArrowRotateClockwiseIcon size={16} />
					)}
					Reconnect GitHub
				</Button>
				<p className="text-xs text-muted-foreground">
					You&apos;ll be sent to GitHub to reinstall the Maple app.
				</p>
			</div>
		</div>
	)
}

function ConnectedView({
	status,
	connectFlow,
	disconnectBusy,
	refreshing,
	deletingRepoId,
	onRefresh,
	onRequestDisconnect,
	onRequestDelete,
	onSetTrackedBranch,
}: {
	status: GithubIntegrationStatus
	connectFlow: IntegrationConnect
	disconnectBusy: boolean
	refreshing: boolean
	deletingRepoId: string | null
	onRefresh: () => void
	onRequestDisconnect: () => void
	onRequestDelete: (repo: GithubRepoSummary) => void
	onSetTrackedBranch: (repo: GithubRepoSummary, branch: string) => Promise<void>
}) {
	const actionBusy = connectFlow.busy || disconnectBusy
	const activeRepos = status.repositories.filter((r) => r.status === "active")
	const removedRepos = status.repositories.filter((r) => r.status === "removed")
	const counts = {
		synced: activeRepos.filter((r) => r.syncStatus === "ready").length,
		syncing: activeRepos.filter((r) => r.syncStatus === "pending" || r.syncStatus === "backfilling")
			.length,
		failed: activeRepos.filter((r) => r.syncStatus === "error").length,
	}
	const scopeLabel =
		status.repositorySelection === "selected" ? "Selected repositories" : "All repositories"

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
				<div className="flex items-center gap-3">
					<span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
					<div className="leading-tight">
						<div className="text-sm font-medium">
							Connected
							{status.accountLogin ? (
								<>
									{" "}
									as{" "}
									<a
										href={`https://github.com/${status.accountLogin}`}
										target="_blank"
										rel="noreferrer"
										className="font-semibold hover:underline"
									>
										@{status.accountLogin}
									</a>
								</>
							) : null}
						</div>
						<div className="text-xs text-muted-foreground">
							{status.accountType === "organization"
								? "Organization"
								: status.accountType === "user"
									? "Personal account"
									: "GitHub App"}{" "}
							· {scopeLabel}
						</div>
					</div>
				</div>

				<div className="flex items-center gap-1.5">
					<Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing}>
						<ArrowRotateClockwiseIcon size={14} className={refreshing ? "animate-spin" : ""} />
						Refresh
					</Button>
					<Button size="sm" variant="outline" onClick={connectFlow.connect} disabled={actionBusy}>
						{connectFlow.busy ? <LoaderIcon size={14} className="animate-spin" /> : null}
						Manage
					</Button>
					<Button size="sm" variant="outline" onClick={onRequestDisconnect} disabled={actionBusy}>
						{disconnectBusy ? <LoaderIcon size={14} className="animate-spin" /> : null}
						Disconnect
					</Button>
				</div>
			</div>

			<div className="overflow-hidden rounded-lg border bg-card">
				<div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
					<h3 className="text-sm font-medium">
						Repositories
						<span className="ml-1.5 text-muted-foreground">{activeRepos.length}</span>
					</h3>
					{activeRepos.length > 0 ? (
						<div className="flex items-center gap-3 text-xs text-muted-foreground">
							{counts.synced > 0 ? (
								<span className="flex items-center gap-1">
									<CircleCheckIcon size={13} className="text-success-foreground" />
									{counts.synced} synced
								</span>
							) : null}
							{counts.syncing > 0 ? (
								<span className="flex items-center gap-1">
									<LoaderIcon size={13} className="animate-spin text-info-foreground" />
									{counts.syncing} syncing
								</span>
							) : null}
							{counts.failed > 0 ? (
								<span className="flex items-center gap-1">
									<CircleWarningIcon size={13} className="text-destructive-foreground" />
									{counts.failed} failed
								</span>
							) : null}
						</div>
					) : null}
				</div>

				{activeRepos.length === 0 && removedRepos.length === 0 ? (
					<div className="flex items-center gap-2.5 px-4 py-6 text-sm text-muted-foreground">
						<LoaderIcon size={16} className="animate-spin" />
						Syncing repositories from GitHub… this can take a moment.
					</div>
				) : (
					<ul className="divide-y">
						{activeRepos.map((repo) => (
							<RepoRow
								key={repo.id}
								repo={repo}
								onSetTrackedBranch={(branch) => onSetTrackedBranch(repo, branch)}
							/>
						))}
					</ul>
				)}
			</div>

			{/* Repos GitHub revoked access to — kept (with history) until explicitly deleted. */}
			{removedRepos.length > 0 ? (
				<div className="overflow-hidden rounded-lg border bg-card">
					<div className="border-b px-4 py-2.5">
						<h3 className="flex items-center gap-1.5 text-sm font-medium">
							<CircleWarningIcon size={15} className="text-warning-foreground" />
							Needs attention
						</h3>
					</div>
					<ul className="divide-y">
						{removedRepos.map((repo) => (
							<li key={repo.id} className="flex items-center gap-3 px-4 py-3">
								<CircleWarningIcon size={17} className="shrink-0 text-warning-foreground" />
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<a
											href={repo.htmlUrl}
											target="_blank"
											rel="noreferrer"
											className="group inline-flex max-w-full items-center gap-1 truncate text-sm font-medium hover:underline"
										>
											<span className="truncate">{repo.fullName}</span>
											<ExternalLinkIcon
												size={12}
												className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
											/>
										</a>
										{repo.isPrivate ? (
											<Badge variant="outline" size="sm" className="shrink-0">
												Private
											</Badge>
										) : null}
									</div>
									<div className="text-xs text-muted-foreground">
										Access removed on GitHub · commit history kept
									</div>
								</div>
								<Button
									size="sm"
									variant="destructive-outline"
									className="shrink-0"
									onClick={() => onRequestDelete(repo)}
									disabled={deletingRepoId !== null}
								>
									{deletingRepoId === repo.id ? (
										<LoaderIcon size={13} className="animate-spin" />
									) : (
										<TrashIcon size={13} />
									)}
									Delete
								</Button>
							</li>
						))}
					</ul>
					<p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
						Re-enable these in the{" "}
						<a
							href="https://github.com/settings/installations"
							target="_blank"
							rel="noreferrer"
							className="font-medium underline underline-offset-2 hover:text-foreground"
						>
							Maple GitHub App
						</a>{" "}
						to resume syncing. Deleting removes their synced commits permanently.
					</p>
				</div>
			) : null}
		</div>
	)
}

/** A single active repository: leading sync-status icon, name + meta, tracked-branch picker. */
function RepoRow({
	repo,
	onSetTrackedBranch,
}: {
	repo: GithubRepoSummary
	onSetTrackedBranch: (branch: string) => Promise<void>
}) {
	const presentation = SYNC_PRESENTATION[repo.syncStatus]
	const StatusIcon = presentation.Icon

	return (
		<li className="flex items-center gap-3 px-4 py-3">
			<StatusIcon
				size={17}
				className={`shrink-0 ${presentation.tone} ${presentation.spin ? "animate-spin" : ""}`}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<a
						href={repo.htmlUrl}
						target="_blank"
						rel="noreferrer"
						className="group inline-flex max-w-full items-center gap-1 truncate text-sm font-medium hover:underline"
					>
						<span className="truncate">{repo.fullName}</span>
						<ExternalLinkIcon
							size={12}
							className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
						/>
					</a>
					{repo.isPrivate ? (
						<Badge variant="outline" size="sm" className="shrink-0">
							Private
						</Badge>
					) : null}
				</div>
				<div className="flex items-center gap-1.5 text-xs">
					<span className={presentation.tone}>{presentation.label}</span>
					{repo.syncStatus === "error" && repo.lastSyncError ? (
						<span className="truncate text-muted-foreground" title={repo.lastSyncError}>
							· {repo.lastSyncError}
						</span>
					) : repo.lastSyncedAt ? (
						<span className="text-muted-foreground">
							· {relativeFromMillis(repo.lastSyncedAt)}
						</span>
					) : null}
				</div>
			</div>
			<BranchSelector repo={repo} onSelect={onSetTrackedBranch} />
		</li>
	)
}

/**
 * Per-repo tracked-branch selector. A repo tracks exactly one branch (seeded to
 * its default); only that branch's commits are synced. Picking a different branch
 * is destructive — it wipes the repo's stored commits and re-backfills the new
 * branch — so it routes through a confirmation dialog. Selection is optimistic and
 * reverts if the save fails.
 */
function BranchSelector({
	repo,
	onSelect,
}: {
	repo: GithubRepoSummary
	onSelect: (trackedBranch: string) => Promise<void>
}) {
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState("")
	const [saving, setSaving] = useState(false)
	// Optimistic view of the tracked branch; falls back to the default like the API.
	const serverTracked = repo.trackedBranch ?? repo.branches.find((b) => b.isDefault)?.name ?? null
	const [tracked, setTracked] = useState<string | null>(serverTracked)
	// The branch awaiting change confirmation (destructive: wipes + resyncs).
	const [pending, setPending] = useState<string | null>(null)

	// Re-sync local selection whenever the server state changes (after a save).
	useEffect(() => {
		setTracked(repo.trackedBranch ?? repo.branches.find((b) => b.isDefault)?.name ?? null)
	}, [repo.trackedBranch, repo.branches])

	// Nothing to offer until branches have synced.
	if (repo.branches.length === 0) return null

	const filtered = query
		? repo.branches.filter((b) => b.name.toLowerCase().includes(query.toLowerCase()))
		: repo.branches

	async function commit(name: string) {
		const prev = tracked
		setTracked(name)
		setSaving(true)
		setOpen(false)
		try {
			await onSelect(name)
		} catch {
			setTracked(prev) // revert on failure
		} finally {
			setSaving(false)
		}
	}

	function pick(name: string) {
		if (name === tracked) {
			setOpen(false)
			return
		}
		// Defer the destructive change to an explicit confirmation.
		setPending(name)
	}

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger
					render={
						<Button
							size="sm"
							variant="outline"
							className="h-7 shrink-0 gap-1.5 px-2.5 font-normal"
							disabled={saving}
						>
							{saving ? <LoaderIcon size={12} className="animate-spin" /> : null}
							<span className="text-muted-foreground">branch</span>
							<span className="max-w-[10rem] truncate font-medium">{tracked ?? "—"}</span>
							<ChevronDownIcon size={12} className="text-muted-foreground" />
						</Button>
					}
				/>
				<PopoverContent align="end" className="w-72 p-0">
					<div className="border-b px-3 py-2.5">
						<p className="text-xs font-medium text-foreground">Tracked branch</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Maple syncs commits from the one branch you track. Changing it re-syncs this
							repo&apos;s commits from the new branch.
						</p>
					</div>
					{repo.branches.length > 8 ? (
						<div className="border-b p-2">
							<input
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search branches…"
								className="w-full rounded-md border bg-transparent px-2 py-1 text-xs outline-none focus:border-ring"
							/>
						</div>
					) : null}
					<div className="max-h-56 overflow-y-auto p-1">
						{filtered.length === 0 ? (
							<p className="px-2 py-1.5 text-xs text-muted-foreground">No matches.</p>
						) : (
							filtered.map((b) => {
								const selected = b.name === tracked
								return (
									<button
										type="button"
										key={b.name}
										onClick={() => pick(b.name)}
										className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50"
									>
										<CheckIcon
											size={14}
											className={`shrink-0 ${selected ? "text-foreground" : "text-transparent"}`}
										/>
										<span className="truncate">{b.name}</span>
										{b.isDefault ? (
											<Badge variant="outline" size="sm" className="ml-auto">
												default
											</Badge>
										) : null}
									</button>
								)
							})
						)}
					</div>
				</PopoverContent>
			</Popover>

			<AlertDialog
				open={pending !== null}
				onOpenChange={(o) => {
					if (!o) setPending(null)
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Change tracked branch</AlertDialogTitle>
						<AlertDialogDescription>
							This switches <span className="font-medium text-foreground">{repo.fullName}</span>{" "}
							to track <span className="font-medium text-foreground">{pending}</span>. Maple
							deletes this repo&apos;s currently synced commits and re-syncs the last 90 days
							from <span className="font-medium text-foreground">{pending}</span>.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								const next = pending
								setPending(null)
								if (next) void commit(next)
							}}
						>
							Track branch
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
