import { useCallback } from "react"
import { Link } from "@tanstack/react-router"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@maple/ui/components/ui/empty"
import { formatRelativeTimeOrDate, toEpochMs } from "@maple/ui/lib/time-format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { formatCount } from "@maple/ui/components/filters/range-filter-section"
import { cn } from "@maple/ui/lib/utils"
import {
	FaceRobotIcon,
	GearIcon,
	PixelSparkleIcon,
	SquareSparkleIcon,
	type IconComponent,
} from "@/components/icons"
import { formatCost } from "@/lib/agent-sessions/session-summary"
import { shortTarget } from "@/lib/agent-sessions/span-filters"
import { vendorIcon } from "@/lib/agent-sessions/vendor-icon"
import { sessionRowId } from "@/lib/agent-sessions/session-window"
import { TOKEN_BUCKETS, type TokenBucketKey } from "@/lib/agent-sessions/token-buckets"
import { vendorLabel } from "@/lib/agent-sessions/vendor-label"
import { CATEGORY_TEXT } from "./session-detail/span-visuals"

/** The wire row from `listAiSessions` — one AI agent session, newest first. */
export interface AgentSessionRow {
	readonly sessionId: string
	readonly vendorId: string
	readonly vendorVersion: string
	readonly traceCount: number
	readonly spanCount: number
	readonly errorSpanCount: number
	/** Failed tool calls, one per failure rather than per span that echoed it. */
	readonly toolErrorCount: number
	/** Failed model calls and turn spans that failed on their own. */
	readonly turnErrorCount: number
	readonly serviceNames: ReadonlyArray<string>
	readonly models: ReadonlyArray<string>
	readonly agentNames: ReadonlyArray<string>
	readonly llmCalls: number
	readonly toolCalls: number
	readonly totalTokens: number
	readonly inputTokens: number
	readonly cacheReadTokens: number
	readonly cacheWriteTokens: number
	readonly outputTokens: number
	readonly reasoningTokens: number
	readonly cost: number
	readonly startTime: string
	readonly endTime: string
	readonly durationMs: number
}

function absoluteTs(startTime: string): string {
	const parsed = toEpochMs(startTime)
	return Number.isNaN(parsed) ? startTime : new Date(parsed).toLocaleString()
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** "claude-sonnet-5 +1": the first model short, the rest as a count — the full
 *  list goes in the title. Gateways prefix models with a provider path that
 *  would truncate two different models to the same string. */
function modelsLabel(models: ReadonlyArray<string>): string {
	const [first, ...rest] = models
	if (first === undefined) return ""
	return rest.length > 0 ? `${shortTarget(first)} +${rest.length}` : shortTarget(first)
}

/** The row's buckets under the detail page's keys, so one palette serves both. */
function rowTokenBuckets(session: AgentSessionRow): Record<TokenBucketKey, number> {
	return {
		input: session.inputTokens,
		cacheRead: session.cacheReadTokens,
		cacheWrite: session.cacheWriteTokens,
		output: session.outputTokens,
		reasoning: session.reasoningTokens,
	}
}

interface AgentSessionsListProps {
	sessions: ReadonlyArray<AgentSessionRow>
	/** Fetch the next page — invoked when the bottom sentinel scrolls into view. */
	onReachEnd?: () => void
	/** Whether more pages remain (renders the sentinel + footer). */
	hasMore?: boolean
	/** Whether a next page is currently in flight. */
	loadingMore?: boolean
	/** The client retention guard stopped pagination before the backend ended. */
	isCapped?: boolean
}

function observeReachEnd(element: HTMLDivElement, onReachEnd: () => void): () => void {
	const observer = new IntersectionObserver(
		(entries) => {
			if (entries[0]?.isIntersecting) onReachEnd()
		},
		{ rootMargin: "400px 0px" },
	)
	observer.observe(element)
	return () => observer.disconnect()
}

function SessionsSentinel({
	onReachEnd,
	loadingMore,
}: Pick<AgentSessionsListProps, "onReachEnd" | "loadingMore">) {
	const elementRef = useCallback(
		(element: HTMLDivElement | null) => {
			if (!element) return
			return observeReachEnd(element, () => {
				if (!loadingMore) onReachEnd?.()
			})
		},
		[loadingMore, onReachEnd],
	)

	return <div ref={elementRef} aria-hidden className="h-px w-full" />
}

export function AgentSessionsList({
	sessions,
	onReachEnd,
	hasMore = false,
	loadingMore = false,
	isCapped = false,
}: AgentSessionsListProps) {
	if (sessions.length === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<SquareSparkleIcon />
					</EmptyMedia>
					<EmptyTitle>No agent sessions yet</EmptyTitle>
					<EmptyDescription>
						Trace your AI agents with a supported framework, or emit OpenTelemetry{" "}
						<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">gen_ai</code>{" "}
						spans, and their sessions will show up here. A framework that groups its turns with a{" "}
						<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.8em]">
							maple_ai.session.id
						</code>{" "}
						attribute gets one session across every trace; anything else gets one per trace.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		)
	}

	return (
		<div className="@container">
			{sessions.map((session) => {
				const hasErrors = session.errorSpanCount > 0
				const VendorIcon = vendorIcon(session.vendorId)
				const vendor = vendorLabel(session.vendorId)
				const hasVersion = session.vendorVersion !== "" && session.vendorVersion !== "0"
				return (
					<Link
						key={session.sessionId}
						to="/agent-sessions/$sessionId"
						params={{ sessionId: session.sessionId }}
						// The session's own bounds, not the list's window: the list query
						// aggregates each qualifying trace in full, so the detail page can
						// read straight from these.
						search={{ t: session.startTime, end: session.endTime }}
						className="relative flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @2xl:gap-4"
					>
						{/* Errored sessions get a left accent so they can be picked out
						    while scanning — same signal as the replays list. */}
						{hasErrors && (
							<span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-destructive" />
						)}

						{/* Identity lane: session id, framework mark underneath. The mark
						    names the framework on its own (the name is in the title); only
						    the version is spelled out, since no logo carries one. */}
						<div className="min-w-0 flex-1 overflow-hidden">
							<div className="flex items-center gap-2">
								<span
									className="min-w-0 truncate font-mono text-sm font-medium"
									title={session.sessionId}
								>
									{sessionRowId(session.sessionId)}
								</span>
								{/* On phones the right-hand lanes are gone, so the timestamp
								    anchors the top-right corner of the stacked row. */}
								<span
									className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground @2xl:hidden"
									title={absoluteTs(session.startTime)}
								>
									{formatRelativeTimeOrDate(session.startTime)}
								</span>
							</div>
							<div
								className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground"
								title={hasVersion ? `${vendor} v${session.vendorVersion}` : vendor}
							>
								<VendorIcon size={13} className="shrink-0" aria-hidden />
								{hasVersion && <span className="truncate">v{session.vendorVersion}</span>}
							</div>
							{hasErrors && (
								<div className="mt-1.5 flex flex-wrap items-center gap-1.5 @2xl:hidden">
									<ErrorChips session={session} />
								</div>
							)}
						</div>

						{/* Services lane */}
						<div className="hidden w-[11rem] shrink-0 overflow-hidden @2xl:block">
							<span
								className="block truncate text-xs text-muted-foreground"
								title={session.serviceNames.join(", ")}
							>
								{session.serviceNames.join(" · ")}
							</span>
						</div>

						{/* Model lane: what the session ran on — the first filter most
						    readers reach for, so it is visible before they open the rail. */}
						<div className="hidden w-[10rem] shrink-0 overflow-hidden @4xl:block">
							<span
								className="block truncate font-mono text-xs text-muted-foreground"
								title={session.models.join(", ")}
							>
								{modelsLabel(session.models)}
							</span>
						</div>

						{/* Activity lane: duration + the work done, in the session page's
						    colours for inference and tools. Traces and spans move to the
						    tooltip — they describe ingestion, calls and tools describe the
						    agent. */}
						<div
							className="hidden w-[13.5rem] shrink-0 items-center gap-2.5 overflow-hidden whitespace-nowrap @3xl:flex"
							title={`${plural(session.traceCount, "trace")} · ${plural(session.spanCount, "span")}`}
						>
							<span className="font-mono text-[13px] font-semibold tabular-nums">
								{formatSessionDuration(session.durationMs)}
							</span>
							<WorkCount
								icon={PixelSparkleIcon}
								tone={CATEGORY_TEXT.inference}
								count={session.llmCalls}
								noun="call"
							/>
							<WorkCount
								icon={GearIcon}
								tone={CATEGORY_TEXT.tool}
								count={session.toolCalls}
								noun="tool"
							/>
						</div>

						{/* Usage lane: the token buckets as a bar, the total and the cost.
						    Blank where nothing was reported — a "0" here would read as
						    "measured, and it was free". */}
						<div className="hidden w-[13rem] shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap @5xl:flex">
							{session.totalTokens > 0 && <TokenBar session={session} />}
							{session.cost > 0 && (
								<span className="font-mono text-xs tabular-nums text-muted-foreground">
									{formatCost(session.cost)}
								</span>
							)}
						</div>

						{/* Signal lane: what failed, tools apart from turns */}
						<div className="hidden w-[7.75rem] shrink-0 flex-col items-start justify-center gap-1 overflow-hidden @2xl:flex">
							{hasErrors && <ErrorChips session={session} />}
						</div>

						{/* Time lane */}
						<div className="hidden shrink-0 items-center @2xl:flex">
							<span
								className="whitespace-nowrap text-xs text-muted-foreground"
								title={absoluteTs(session.startTime)}
							>
								{formatRelativeTimeOrDate(session.startTime)}
							</span>
						</div>
					</Link>
				)
			})}

			{hasMore && <SessionsSentinel onReachEnd={onReachEnd} loadingMore={loadingMore} />}

			{isCapped && (
				<p className="py-3 text-sm text-muted-foreground">
					Showing the {sessions.length.toLocaleString()} most recent sessions — filter the list to
					see older ones
				</p>
			)}

			{loadingMore && (
				<div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
					<span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
					Loading more sessions…
				</div>
			)}
		</div>
	)
}

/** "12 calls" with the kind's glyph, in its hue — the same pair the session
 *  page's waterfall and flow use for the kind of work. */
function WorkCount({
	icon: Icon,
	tone,
	count,
	noun,
}: {
	icon: IconComponent
	tone: string
	count: number
	noun: string
}) {
	return (
		<span className={cn("inline-flex items-center gap-1 text-xs tabular-nums", tone)}>
			<Icon size={12} className="shrink-0" aria-hidden />
			{plural(count, noun)}
		</span>
	)
}

/**
 * The detail page's Tokens rail at row height: one segment per non-empty
 * bucket, in that rail's fills, so cached against fresh against generated can
 * be compared down the list. The figures stay in the title; the total beside
 * the bar is the index's, which the sort and filter read.
 */
function TokenBar({ session }: { session: AgentSessionRow }) {
	const buckets = rowTokenBuckets(session)
	const drawn = TOKEN_BUCKETS.filter((bucket) => buckets[bucket.key] > 0)
	const bucketTotal = drawn.reduce((sum, bucket) => sum + buckets[bucket.key], 0)
	const title = [
		`${session.totalTokens.toLocaleString()} tokens`,
		...drawn.map((bucket) => `${bucket.label}: ${buckets[bucket.key].toLocaleString()}`),
	].join("\n")
	return (
		<span className="inline-flex items-center gap-2" title={title}>
			{/* A session that reported only a total draws no bar — an empty track
			    would read as "measured, and it was nothing". */}
			{bucketTotal > 0 && (
				<span aria-hidden className="flex h-1.5 w-16 gap-px overflow-hidden rounded-xs bg-muted">
					{drawn.map((bucket) => (
						<span
							key={bucket.key}
							className={bucket.fill}
							style={{ width: `${(buckets[bucket.key] / bucketTotal) * 100}%` }}
						/>
					))}
				</span>
			)}
			<span className="font-mono text-xs tabular-nums text-muted-foreground">
				{formatCount(session.totalTokens)} tok
			</span>
		</span>
	)
}

/**
 * Tool failures apart from turn failures: a tool that errored is something the
 * agent may have recovered from, a turn that failed is the session not
 * answering — so they are two chips in two tones rather than one count. A
 * failure the index cannot classify (an errored span outside the agent's own)
 * still lights the row's accent, and shows here only when it is all there is.
 */
function ErrorChips({ session }: { session: AgentSessionRow }) {
	const classified = session.toolErrorCount + session.turnErrorCount
	const other = Math.max(0, session.errorSpanCount - classified)
	return (
		<>
			{session.turnErrorCount > 0 && (
				<ErrorChip
					icon={FaceRobotIcon}
					count={session.turnErrorCount}
					noun="turn error"
					className="border-destructive/30 bg-destructive/10 text-destructive"
				/>
			)}
			{session.toolErrorCount > 0 && (
				<ErrorChip
					icon={GearIcon}
					count={session.toolErrorCount}
					noun="tool error"
					className="border-severity-warn/40 bg-severity-warn/10 text-severity-warn"
				/>
			)}
			{classified === 0 && other > 0 && (
				<ErrorChip
					count={other}
					noun="error"
					className="border-destructive/30 bg-destructive/10 text-destructive"
				/>
			)}
		</>
	)
}

function ErrorChip({
	icon: Icon,
	count,
	noun,
	className,
}: {
	icon?: IconComponent
	count: number
	noun: string
	className: string
}) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums",
				className,
			)}
		>
			{Icon ? (
				<Icon size={10} className="shrink-0" aria-hidden />
			) : (
				<span className="size-1 rounded-full bg-current" aria-hidden />
			)}
			{plural(count, noun)}
		</span>
	)
}
