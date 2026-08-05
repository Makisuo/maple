import { Link, type LinkProps } from "@tanstack/react-router"
import type { Schema } from "effect"
import type { JourneyListItem } from "@maple/domain/http"

import { cn } from "@maple/ui/lib/utils"
import { ArrowsSwapIcon } from "@/components/icons"
import { isTruncated, journeyIdentity, journeyMetaLine, journeyModels } from "./journey-identity"
import { absoluteTimestamp, formatCost, formatJourneyDuration, formatTokens } from "./journeys-format"
import { COST_OUTLIER_DOLLARS } from "./journeys-filter-inputs"

/**
 * One row of the journeys list — the wire type itself, not a restatement of it.
 * Derived from the domain schema so a field that changes shape server-side is a
 * compile error here rather than a cast that keeps compiling.
 */
export type JourneyRow = Schema.Schema.Type<typeof JourneyListItem>

// Six lanes: one flexible, five fixed. The widths are shared by the column strip
// and every row, so the numeric columns stay a column rather than a ragged edge.
const LANE = {
	marker: "w-3.5 shrink-0",
	model: "w-36.5 shrink-0",
	turns: "w-15 shrink-0",
	tokens: "w-24 shrink-0",
	time: "w-19 shrink-0",
	cost: "w-24 shrink-0",
} as const

/** Numeric lanes disappear before the identity lane does — a journey you can't
 *  name is useless, a journey without a token count is still triageable. */
const HIDE = {
	model: "hidden @3xl:flex",
	turns: "hidden @2xl:flex",
	tokens: "hidden @xl:flex",
} as const

const VALUE_TEXT = "font-mono text-sm tabular-nums text-foreground/85"

/**
 * The detail link, with the partition-pruning hint the detail route documents.
 *
 * `t` is any warehouse timestamp inside the journey — the row's own start. Without
 * it the detail route falls back to a 7-day window ending *now*, which both scans
 * seven days of partitions on every click and misses a journey the list only
 * showed because the user asked for an older custom range.
 */
export const detailLinkProps = (journey: Pick<JourneyRow, "journeyId" | "startTime">): LinkProps => ({
	to: "/journeys/$journeyId",
	params: { journeyId: journey.journeyId },
	search: { t: journey.startTime },
})

export interface JourneyColumnSort {
	readonly active: "startTime" | "cost" | "duration" | "turns" | "tokens"
	readonly direction: "asc" | "desc"
	readonly onSort: (key: "cost" | "duration" | "turns" | "tokens") => void
}

/**
 * The column strip. Clicking a numeric header sorts by that column and updates
 * the toolbar's sort control — the two are one setting with two surfaces.
 */
export function JourneyColumnStrip({ sort }: { sort?: JourneyColumnSort }) {
	const header = (label: string, key?: "cost" | "duration" | "turns" | "tokens") => {
		const isActive = key != null && sort?.active === key
		const content = (
			<>
				{label}
				{isActive && (
					<span aria-hidden className="ml-1 text-foreground">
						{sort?.direction === "asc" ? "↑" : "↓"}
					</span>
				)}
			</>
		)
		if (!key || !sort) return <span>{content}</span>
		// The arrow is decorative, and colour alone can't carry "this is the active
		// sort" — so the pressed state and the direction both go in the label, the
		// same way the toolbar's chips do it.
		const direction = sort.direction === "asc" ? "ascending" : "descending"
		return (
			<button
				type="button"
				onClick={() => sort.onSort(key)}
				aria-pressed={isActive}
				className={cn(
					"rounded-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					isActive && "text-foreground",
				)}
				aria-label={
					isActive
						? `Sort by ${label.toLowerCase()}, ${direction}`
						: `Sort by ${label.toLowerCase()}`
				}
			>
				{content}
			</button>
		)
	}

	return (
		<div className="flex h-7 items-center gap-3.5 border-b border-border font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
			<div className={LANE.marker} />
			<div className="min-w-0 flex-1">JOURNEY</div>
			<div className={cn(LANE.model, HIDE.model)}>MODEL</div>
			<div className={cn(LANE.turns, HIDE.turns, "justify-end")}>{header("TURNS", "turns")}</div>
			<div className={cn(LANE.tokens, HIDE.tokens, "justify-end")}>{header("TOKENS", "tokens")}</div>
			<div className={cn(LANE.time, "flex justify-end")}>{header("TIME", "duration")}</div>
			<div className={cn(LANE.cost, "flex justify-end")}>{header("COST", "cost")}</div>
		</div>
	)
}

interface JourneyListRowProps {
	journey: JourneyRow
	/** The most expensive journey in view — the cost bar is scaled against it, so
	 *  the column reads as a distribution rather than a set of unrelated widths. */
	maxCost: number
	/** Suppressed when the whole view is redacted; the page banner says it once
	 *  instead of every row repeating it. */
	showRedactedInMeta: boolean
}

export function JourneyListRow({ journey, maxCost, showRedactedInMeta }: JourneyListRowProps) {
	const identity = journeyIdentity(journey)
	const meta = journeyMetaLine(journey, identity, {
		showRedacted: showRedactedInMeta,
	})
	const models = journeyModels(journey)
	const truncated = isTruncated(journey)
	const cost = formatCost(journey.cost)
	const expensive = journey.cost != null && journey.cost >= COST_OUTLIER_DOLLARS

	return (
		<Link
			{...detailLinkProps(journey)}
			className="group flex h-16 items-center gap-3.5 border-b border-border px-0 transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
		>
			{/* Status marker. A round dot is a live journey, a square is a failure —
			    shape, not colour alone, carries it. */}
			<div className={cn(LANE.marker, "flex justify-center")}>
				{journey.status === "running" && (
					<span
						className="relative flex size-1.75"
						title="Running now — best-effort estimate based on recent trace activity, may not be 100% accurate in edge cases"
					>
						<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
						<span className="relative inline-flex size-1.75 rounded-full bg-success" />
					</span>
				)}
				{journey.status === "error" && (
					<span
						className="size-1.75 rounded-[1.5px] bg-destructive"
						title="This journey ended in an error"
					/>
				)}
			</div>

			{/* Identity lane */}
			<div className="flex min-w-0 flex-1 flex-col gap-1.25">
				<div className="flex min-w-0 items-center gap-2">
					<span
						className={cn(
							"min-w-0 truncate text-base/4",
							identity.kind === "message"
								? "font-medium tracking-[-0.01em] text-foreground"
								: "font-mono text-foreground",
						)}
						title={identity.label}
					>
						{identity.label}
					</span>
					{identity.kindLabel && (
						<span className="shrink-0 font-mono text-xs text-muted-foreground">
							{identity.kindLabel}
						</span>
					)}
					{truncated && <JourneyBadge tone="warning">TRUNCATED</JourneyBadge>}
					{journey.status === "error" && (
						<JourneyBadge tone="destructive">PROVIDER ERROR</JourneyBadge>
					)}
				</div>
				<div
					className="flex min-w-0 items-center gap-1.75 font-mono text-xs"
					title={absoluteTimestamp(journey.startTime)}
				>
					{meta.lead && <span className="truncate text-foreground/85">{meta.lead}</span>}
					<span className="truncate text-muted-foreground">{meta.rest}</span>
				</div>
			</div>

			{/* Model lane */}
			<div className={cn(LANE.model, HIDE.model, "items-center gap-1.5 overflow-hidden")}>
				<span className={cn(VALUE_TEXT, "truncate")} title={models.all.join(", ")}>
					{models.primary ?? "—"}
				</span>
				{models.overflow > 0 && (
					<span
						className="flex h-4.25 shrink-0 items-center rounded-sm border border-border px-1.25 font-mono text-xs text-muted-foreground tabular-nums"
						title={`Also used ${models.all.slice(1).join(", ")}`}
					>
						+{models.overflow}
					</span>
				)}
				{models.diverged && (
					<span
						className="shrink-0 text-warning"
						title={`Served model differs from the requested one (${models.requested.join(", ")})`}
					>
						<ArrowsSwapIcon className="size-3.5" />
					</span>
				)}
			</div>

			<div className={cn(LANE.turns, HIDE.turns, "justify-end")}>
				<span className={VALUE_TEXT}>{journey.turnCount.toLocaleString()}</span>
			</div>

			<div className={cn(LANE.tokens, HIDE.tokens, "justify-end")}>
				<span className={VALUE_TEXT} title={`${journey.totalTokens.toLocaleString()} tokens`}>
					{formatTokens(journey.totalTokens)}
				</span>
			</div>

			<div className={cn(LANE.time, "flex justify-end")}>
				<span className={VALUE_TEXT}>{formatJourneyDuration(journey.durationMs)}</span>
			</div>

			{/* Cost lane: a bar growing leftward from the figure's edge, scaled
			    against the most expensive journey in view. Nothing else in the row
			    competes for colour, so the outlier is the one thing that reads. */}
			<div className={cn(LANE.cost, "flex items-center justify-end gap-2")}>
				<span className="flex w-8 shrink-0 justify-end">
					{journey.cost != null && maxCost > 0 && (
						<span
							aria-hidden
							className={cn(
								"h-0.75 rounded-[2px]",
								expensive ? "bg-primary" : "bg-muted-foreground/50",
							)}
							style={{
								width: `${Math.max(8, Math.min(100, (journey.cost / maxCost) * 100))}%`,
							}}
						/>
					)}
				</span>
				<span className="flex w-13 shrink-0 justify-end">
					{cost ? (
						<span
							className={cn(
								"font-mono text-sm tabular-nums",
								expensive ? "font-medium text-primary" : "text-foreground",
							)}
						>
							{cost}
						</span>
					) : (
						// No span carried a cost attribute. An em dash, never $0.00.
						<span
							className="font-mono text-sm text-muted-foreground/60"
							title="No cost data on this journey's spans"
						>
							—
						</span>
					)}
				</span>
			</div>
		</Link>
	)
}

function JourneyBadge({ tone, children }: { tone: "warning" | "destructive"; children: React.ReactNode }) {
	return (
		<span
			className={cn(
				"flex h-4.25 shrink-0 items-center rounded-sm px-1.5 font-mono text-xs tracking-[0.04em]",
				tone === "warning"
					? "bg-warning/15 text-warning-foreground"
					: "bg-destructive/15 text-destructive",
			)}
		>
			{children}
		</span>
	)
}
