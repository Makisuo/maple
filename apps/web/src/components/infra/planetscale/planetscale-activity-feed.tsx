import type { PlanetScaleEventEntry } from "@/api/warehouse/planetscale-infra"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"

import { ExternalLinkIcon } from "@/components/icons"
import { presentEvent } from "./planetscale-events"

/**
 * What happened to this database in the window — deploys, branch promotions,
 * maintenance, OOM restarts — newest first.
 *
 * The chart markers above are the index into this; the feed is the detail. It
 * shows *every* event, including the ones deliberately kept off the chart
 * (routine `branch.ready` churn), because "nothing on the chart" and "nothing
 * happened" are different answers.
 *
 * Events are fetched once by the page and passed down, so the markers and the
 * feed can never disagree about what happened.
 */
export function PlanetScaleActivityFeed({
	events,
	waiting,
	emptyMessage = "No deploys or branch events in this window.",
	onSelectBranch,
}: {
	events: ReadonlyArray<PlanetScaleEventEntry>
	waiting?: boolean
	emptyMessage?: string
	onSelectBranch?: (branch: string) => void
}) {
	if (events.length === 0) {
		return <p className="py-3 text-xs text-muted-foreground">{emptyMessage}</p>
	}
	return (
		<ul className={cn("flex flex-col transition-opacity", waiting && "opacity-60")}>
			{events.map((event) => (
				<PlanetScaleActivityRow
					key={event.id}
					eventType={event.eventType}
					title={event.title}
					branchName={event.branchName}
					occurredAt={event.occurredAt}
					url={event.url}
					actorLogin={event.actorLogin}
					onSelectBranch={onSelectBranch}
				/>
			))}
		</ul>
	)
}

/** One row: severity rail, title, branch, relative time. */
export function PlanetScaleActivityRow({
	eventType,
	title,
	branchName,
	occurredAt,
	url,
	actorLogin,
	onSelectBranch,
}: {
	eventType: string
	title: string
	branchName: string
	occurredAt: number
	url: string | null
	actorLogin: string | null
	onSelectBranch?: (branch: string) => void
}) {
	const presentation = presentEvent(eventType)
	return (
		<li className="flex items-baseline gap-2.5 border-l border-border/60 py-1.5 pl-3 text-xs">
			{/* Not SeverityDot: that primitive speaks host *status* (active/idle/…),
			    which is a different vocabulary from event severity. */}
			<span
				aria-hidden
				className={cn(
					"mt-1 size-1.5 shrink-0 rounded-full",
					presentation.tone === "crit"
						? "bg-severity-error"
						: presentation.tone === "warn"
							? "bg-severity-warn"
							: "bg-muted-foreground/50",
				)}
			/>
			<span className="min-w-0 flex-1 truncate text-foreground/90">{title}</span>
			{branchName !== "" ? (
				onSelectBranch !== undefined ? (
					<button
						type="button"
						onClick={() => onSelectBranch(branchName)}
						className="shrink-0 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
					>
						{branchName}
					</button>
				) : (
					<span className="shrink-0 font-mono text-[11px] text-muted-foreground">{branchName}</span>
				)
			) : null}
			{actorLogin !== null ? (
				<span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
					{actorLogin}
				</span>
			) : null}
			{url !== null ? (
				<a
					href={url}
					target="_blank"
					rel="noreferrer"
					className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
					aria-label="Open in PlanetScale"
				>
					<ExternalLinkIcon size={12} />
				</a>
			) : null}
			<span className="shrink-0 tabular-nums text-muted-foreground">
				{formatRelativeTime(new Date(occurredAt).toISOString())}
			</span>
		</li>
	)
}

export function PlanetScaleActivityFeedLoading({ rows = 4 }: { rows?: number }) {
	return (
		<ul className="flex flex-col">
			{Array.from({ length: rows }, (_, index) => (
				<li key={index} className="border-l border-border/60 py-1.5 pl-3">
					<Skeleton className={cn("h-3", index % 2 === 0 ? "w-64" : "w-48")} />
				</li>
			))}
		</ul>
	)
}
