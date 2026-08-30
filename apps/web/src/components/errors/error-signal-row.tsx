import { Link } from "@tanstack/react-router"

import type { ErrorIssueId } from "@maple/domain/http"
import { ServiceDot } from "@maple/ui/components/service-dot"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import { normalizeTimestampInput } from "@/lib/timezone-format"
import type { ErrorSignal } from "@/lib/models/error-signal"
import { densifySpark, surgeRatio } from "@/lib/models/error-signal"

import { BranchForkIcon, ChatBubbleIcon } from "@/components/icons"

import { ActorAvatar } from "./actor-chip"
import { IssueContextMenu } from "./issue-context-menu"
import { SeverityBadge } from "./severity-badge"
import { SignalSpark } from "./signal-spark"
import { SignalStateChip } from "./signal-state-chip"
import type { IssueMutations } from "./use-issue-mutations"

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function formatLastSeen(iso: string): string {
	const d = new Date(normalizeTimestampInput(iso))
	if (Number.isNaN(d.getTime())) return iso
	const diffMs = Date.now() - d.getTime()
	if (diffMs < 60_000) return "now"
	if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m`
	if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h`
	if (diffMs < WEEK_MS) return `${Math.floor(diffMs / 86_400_000)}d`
	const sameYear = d.getFullYear() === new Date().getFullYear()
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: sameYear ? undefined : "numeric",
	})
}

/** A burst this far above the window's own average tail is worth calling out. */
const SURGE_THRESHOLD = 2.5

/**
 * Comment and PR marks for a row. Deliberately muted — they answer "is anyone
 * on this?" without competing with severity and the incident chip, and a row
 * nobody has touched draws nothing rather than a line of zeros.
 *
 * They ride at the end of the identity lane rather than in a column of their
 * own. As a column they held 64px on every row to say something about roughly
 * a third of them, and that 64px was taken from the error message — the lane
 * the list is actually read by.
 */
function SignalActivity({
	commentCount,
	openPullRequestCount,
	mergedPullRequestCount,
}: {
	commentCount: number
	openPullRequestCount: number
	mergedPullRequestCount: number
}) {
	const prCount = openPullRequestCount + mergedPullRequestCount
	if (commentCount === 0 && prCount === 0) return null
	return (
		<span className="ml-auto flex shrink-0 items-center gap-2 pl-3">
			{commentCount > 0 ? (
				<span
					className="flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground"
					title={`${commentCount} comment${commentCount === 1 ? "" : "s"} on the timeline`}
				>
					<ChatBubbleIcon size={11} />
					{commentCount}
				</span>
			) : null}
			{prCount > 0 ? (
				<span
					className={cn(
						"flex items-center gap-1 text-[11px] tabular-nums",
						mergedPullRequestCount > 0 ? "text-foreground/70" : "text-muted-foreground",
					)}
					title={
						mergedPullRequestCount > 0
							? `${prCount} pull request${prCount === 1 ? "" : "s"} · ${mergedPullRequestCount} merged`
							: `${prCount} open pull request${prCount === 1 ? "" : "s"}`
					}
				>
					<BranchForkIcon size={11} />
					{prCount}
				</span>
			) : null}
		</span>
	)
}

/**
 * Lane geometry, shared by the header and the rows so the two cannot drift.
 * Width and container-query breakpoint only — each use adds its own display,
 * because the row's service lane needs `flex` for the dot while the header's
 * does not.
 */
const LANE = {
	severity: "w-[60px] shrink-0",
	/** The lane that grows, and the last one to give ground. Every other lane
	 *  now switches on at the width where the identity can still afford it —
	 *  at 600px this row used to truncate `TypeError` to `Type…` while a 56px
	 *  sparkline and a mostly-empty activity column kept their space. */
	identity: "min-w-0 flex-1",
	/** Trend and count are one fact — "how much, and in what shape" — so they
	 *  share a lane and read as a pair. The count arrives first (@lg); the
	 *  shape needs real width to say anything, so it waits for @2xl. */
	volume: "hidden w-[52px] shrink-0 items-center justify-end gap-2 @lg/page:flex @2xl/page:w-[148px]",
	spark: "hidden min-w-0 flex-1 @2xl/page:block",
	count: "w-[52px] shrink-0 text-right",
	service: "hidden w-[92px] shrink-0 @xl/page:block",
	// Sized to the longest label: "Open incident"/"Investigating" run ~98px in
	// 11px Geist Mono plus the dot — 92px forced them onto two lines.
	state: "hidden w-[104px] shrink-0 @3xl/page:block",
	actor: "w-5 shrink-0",
	lastSeen: "w-[64px] shrink-0",
} as const

/** Row and header share this so the columns line up under each other. */
const ROW_SHELL = "flex items-center gap-3 px-3"

/**
 * Column labels.
 *
 * The list ran without a header, which works while every lane is
 * self-describing — and three of them were not. A bare "13.2K" could be events
 * or milliseconds, a bare "31m" could be an age or a duration, and the
 * sparkline had no stated units at all. The answers were in `title` tooltips,
 * which is the same as not being there.
 *
 * Severity and assignee stay unlabelled: a chip reading "Critical" and a face
 * do not need telling.
 */
export function ErrorSignalHeader() {
	return (
		<div
			className={cn(
				ROW_SHELL,
				"h-7 border-b border-border/60 bg-muted/30 text-[10px] font-medium tracking-wide text-muted-foreground uppercase",
			)}
		>
			<span className={LANE.severity} />
			<span className={LANE.identity}>Error</span>
			<span className={LANE.volume}>
				<span className={LANE.spark}>Trend</span>
				<span className={LANE.count}>Events</span>
			</span>
			<span className={LANE.service}>Service</span>
			<span className={LANE.state}>Status</span>
			<span className={LANE.actor} />
			<span className={cn(LANE.lastSeen, "text-right")}>Last seen</span>
		</div>
	)
}

/**
 * A row that has not arrived yet.
 *
 * Lives here, next to `LANE`, because a placeholder drawn to different geometry
 * than the thing it stands in for is what makes a list jump when it loads. Six
 * full-width bars said "something is coming"; these say "these columns are
 * coming", and every lane lands in the pixel column it will occupy.
 */
export function ErrorSignalRowSkeleton({ index }: { index: number }) {
	// Fixed widths rather than random ones: a list that reshuffles its own
	// placeholder on every render reads as activity, and there is none.
	const identityWidth = ["72%", "48%", "61%", "39%", "55%", "44%"][index % 6]

	return (
		<div className={cn(ROW_SHELL, "h-11")} aria-hidden="true">
			<span className={cn(LANE.severity, "flex items-center")}>
				<Skeleton className="h-5 w-12 rounded-sm" />
			</span>
			<span className={LANE.identity}>
				<Skeleton className="h-3.5" style={{ width: identityWidth }} />
			</span>
			<span className={LANE.volume}>
				<span className={LANE.spark}>
					<Skeleton className="h-4 w-full" />
				</span>
				<span className={LANE.count}>
					<Skeleton className="ml-auto h-3 w-8" />
				</span>
			</span>
			<span className={LANE.service}>
				<Skeleton className="h-3 w-16" />
			</span>
			<span className={LANE.state}>
				<Skeleton className="h-3 w-20" />
			</span>
			<span className={LANE.actor}>
				<Skeleton className="size-5 rounded-full" />
			</span>
			<span className={cn(LANE.lastSeen, "flex justify-end")}>
				<Skeleton className="h-3 w-7" />
			</span>
		</div>
	)
}

export interface ErrorSignalRowProps {
	signal: ErrorSignal
	sparkWindow: { readonly startMs: number; readonly endMs: number; readonly bucketMs: number }
	mutations: IssueMutations
	selected: boolean
	focused: boolean
	onFocus: (id: ErrorIssueId) => void
}

/**
 * One fingerprint, read left to right in the order the triage question is
 * actually asked: what is it, what shape is it, how much, where, who or what is
 * on it, and when did it last happen.
 *
 * The row IS the link rather than carrying an absolutely-positioned overlay one.
 * The overlay version was unclickable in practice: it sat at `z-auto` while every
 * content lane was `relative z-10`, so the link painted *underneath* all of them
 * and only the padding gaps between lanes actually navigated. Making the row the
 * anchor also means the title, the message and every number are real click
 * targets, and the whole row takes one tab stop instead of none.
 */
export function ErrorSignalRow({
	signal,
	sparkWindow,
	mutations,
	selected,
	focused,
	onFocus,
}: ErrorSignalRowProps) {
	const href = `/errors/issues/${signal.id}`
	const dense = densifySpark(signal.spark, sparkWindow)
	const surge = surgeRatio(dense)
	const isSurging = surge !== null && surge >= SURGE_THRESHOLD

	return (
		<IssueContextMenu
			issue={signal.issue}
			mutations={mutations}
			issueUrl={href}
			onOpenInNewTab={() => window.open(href, "_blank", "noopener,noreferrer")}
		>
			<Link
				to="/errors/issues/$issueId"
				params={{ issueId: signal.id }}
				data-issue-id={signal.id}
				data-focused={focused || undefined}
				data-selected={selected || undefined}
				onMouseEnter={() => onFocus(signal.id)}
				className={cn(
					ROW_SHELL,
					"group/row h-11 text-sm",
					"hover:bg-muted/50 data-focused:bg-muted/40",
					"data-selected:bg-primary/10 data-selected:hover:bg-primary/15",
					"focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
					"transition-colors",
				)}
			>
				<span className={cn(LANE.severity, "flex items-center")}>
					<SeverityBadge
						severity={signal.severity}
						className="h-5 max-w-full truncate px-1.5 text-[10px]"
					/>
				</span>

				{/* Identity dominates. The message only appears once the lane is wide
				    enough for both (@4xl); below that the type takes the whole lane,
				    because a row whose title truncates to "Connect…" has lost the only
				    thing you scan for, and a half-truncated pair loses both. Where both
				    fit, the type holds up to 60% and the message gives way first. */}
				<span className={cn(LANE.identity, "flex items-baseline gap-2")}>
					<span
						className="min-w-0 truncate font-medium text-foreground @4xl/page:max-w-[60%] @4xl/page:shrink-0"
						title={signal.title}
					>
						{signal.title}
					</span>
					{signal.detail ? (
						<span
							className="hidden min-w-0 flex-1 truncate text-muted-foreground @4xl/page:inline"
							title={signal.detail}
						>
							{signal.detail}
						</span>
					) : null}
					<SignalActivity
						commentCount={signal.commentCount}
						openPullRequestCount={signal.openPullRequestCount}
						mergedPullRequestCount={signal.mergedPullRequestCount}
					/>
				</span>

				<span className={LANE.volume}>
					<span className={LANE.spark}>
						<SignalSpark
							values={dense}
							severity={signal.severity}
							surging={isSurging}
							label={
								isSurging
									? `Surging — ${formatNumber(signal.windowCount ?? 0)} occurrences, concentrated at the end of the window`
									: `${formatNumber(signal.windowCount ?? 0)} occurrences over the window`
							}
						/>
					</span>

					<span
						className={cn(LANE.count, "text-xs tabular-nums")}
						title={
							signal.windowCount === null
								? `No occurrences in this window · ${signal.totalCount.toLocaleString()} all time`
								: `${signal.windowCount.toLocaleString()} in this window · ${signal.totalCount.toLocaleString()} all time`
						}
					>
						{signal.windowCount === null ? (
							<span className="text-muted-foreground/50">—</span>
						) : (
							<span
								className={
									isSurging ? "font-medium text-destructive" : "text-muted-foreground"
								}
							>
								{formatNumber(signal.windowCount)}
							</span>
						)}
					</span>
				</span>

				<span
					className={cn(
						LANE.service,
						"items-center gap-1.5 text-xs text-muted-foreground @xl/page:flex",
					)}
					title={signal.serviceName}
				>
					<ServiceDot serviceName={signal.serviceName} className="size-1.5" />
					<span className="truncate">{signal.serviceName}</span>
				</span>

				<span className={LANE.state}>
					<SignalStateChip state={signal.state} withConfidence={false} />
				</span>

				<span className={LANE.actor}>
					<ActorAvatar actor={signal.assignee} />
				</span>

				<span
					className={cn(LANE.lastSeen, "text-right text-xs tabular-nums text-muted-foreground")}
					title={`Last seen ${new Date(normalizeTimestampInput(signal.lastSeenAt)).toLocaleString()}`}
				>
					{formatLastSeen(signal.lastSeenAt)}
				</span>
			</Link>
		</IssueContextMenu>
	)
}
