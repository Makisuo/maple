import { Link } from "@tanstack/react-router"

import type { ErrorIssueId } from "@maple/domain/http"
import { ServiceDot } from "@maple/ui/components/service-dot"
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
 * Comment and PR marks for a row. Deliberately muted — the lane answers "is
 * anyone on this?" without competing with severity and the incident chip, and
 * a row nobody has touched stays empty rather than showing a line of zeros.
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
		<>
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
		</>
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
	identity: "min-w-0 flex-1",
	spark: "hidden w-[56px] shrink-0 @lg/page:block",
	count: "hidden w-[52px] shrink-0 @xl/page:block",
	service: "hidden w-[92px] shrink-0 @md/page:block",
	state: "hidden w-[92px] shrink-0 @2xl/page:block",
	activity: "hidden w-[64px] shrink-0 @xl/page:block",
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
			<span className={LANE.spark}>Trend</span>
			<span className={cn(LANE.count, "text-right")}>Events</span>
			<span className={LANE.service}>Service</span>
			<span className={LANE.state}>Status</span>
			<span className={LANE.activity}>Activity</span>
			<span className={LANE.actor} />
			<span className={cn(LANE.lastSeen, "text-right")}>Last seen</span>
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

				{/* Identity dominates. The type holds its width up to 60% of the lane
				    and the message gives way first — a row whose title truncates to
				    "Connect…" has lost the only thing you scan for. */}
				<span className={cn(LANE.identity, "flex items-baseline gap-2")}>
					<span
						className="max-w-[60%] shrink-0 truncate font-medium text-foreground"
						title={signal.title}
					>
						{signal.title}
					</span>
					{signal.detail ? (
						<span
							className="hidden min-w-0 flex-1 truncate text-muted-foreground @md/page:inline"
							title={signal.detail}
						>
							{signal.detail}
						</span>
					) : null}
				</span>

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
					className={cn(LANE.count, "text-right text-xs tabular-nums")}
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
							className={isSurging ? "font-medium text-destructive" : "text-muted-foreground"}
						>
							{formatNumber(signal.windowCount)}
						</span>
					)}
				</span>

				<span
					className={cn(
						LANE.service,
						"items-center gap-1.5 text-xs text-muted-foreground @md/page:flex",
					)}
					title={signal.serviceName}
				>
					<ServiceDot serviceName={signal.serviceName} className="size-1.5" />
					<span className="truncate">{signal.serviceName}</span>
				</span>

				<span className={LANE.state}>
					<SignalStateChip state={signal.state} />
				</span>

				<span className={cn(LANE.activity, "items-center gap-2 @xl/page:flex")}>
					<SignalActivity
						commentCount={signal.commentCount}
						openPullRequestCount={signal.openPullRequestCount}
						mergedPullRequestCount={signal.mergedPullRequestCount}
					/>
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
