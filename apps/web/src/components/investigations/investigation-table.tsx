import type { MouseEvent } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import type { V2Investigation } from "@maple/domain/http/v2"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { cn } from "@maple/ui/lib/utils"
import { formatRelativeTime, toEpochMs } from "@maple/ui/lib/time-format"

import { SeverityBadge } from "@/components/errors/severity-badge"
import { ConfidenceMeter } from "./confidence-meter"
import { hasFanout, lensTally, placeholderLenses } from "./fanout-placeholder"
import {
	investigationFinding,
	investigationHeadline,
	investigationScope,
	investigationSeverity,
} from "./investigation-display"
import { InvestigationKindMarker, InvestigationStatusBadge } from "./investigation-status"

/**
 * Not a table any more.
 *
 * The old grid gave Subject and Finding a column each and then had to truncate
 * both to fit five more, so the one thing worth reading — what Maple concluded —
 * arrived as half a sentence. Stacking the finding under the subject gives it the
 * full width of the row, and the remaining columns shrink to what they actually
 * need: a meter, a badge, a word, a timestamp.
 *
 * Sorting moved to the toolbar's select, which is why no header row survives.
 */
export function InvestigationTable({ investigations }: { investigations: ReadonlyArray<V2Investigation> }) {
	return (
		<ul className="flex flex-col">
			{investigations.map((investigation) => (
				<InvestigationRow key={investigation.id} investigation={investigation} />
			))}
		</ul>
	)
}

function InvestigationRow({ investigation }: { investigation: V2Investigation }) {
	const navigate = useNavigate()
	const headline = investigationHeadline(investigation)
	const scope = investigationScope(investigation)
	const finding = investigationFinding(investigation)

	// The headline stays a real link so cmd-click and "open in new tab" work; the
	// row handler is the convenience path and must not double-fire on it.
	const openRow = (event: MouseEvent<HTMLLIElement>) => {
		if (event.defaultPrevented) return
		if ((event.target as HTMLElement).closest("a")) return
		void navigate({ to: "/investigations/$id", params: { id: investigation.id } })
	}

	return (
		<li
			className="flex cursor-pointer items-center gap-3.5 border-b px-4 py-3.5 transition-colors last:border-b-0 hover:bg-accent/40"
			onClick={openRow}
		>
			<span className="flex w-5 shrink-0 items-center justify-center">
				<InvestigationKindMarker subject={investigation.subject} seededBy={investigation.seeded_by} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex min-w-0 items-baseline gap-2">
					<Link
						to="/investigations/$id"
						params={{ id: investigation.id }}
						className="truncate font-medium text-sm text-foreground hover:underline"
						title={headline}
					>
						{headline}
					</Link>
					{scope ? (
						<span className="shrink-0 truncate text-xs text-muted-foreground" title={scope}>
							{scope}
						</span>
					) : null}
				</div>
				<RowFinding investigation={investigation} finding={finding} />
			</div>
			<span className="w-20 shrink-0 max-md:hidden">
				<ConfidenceMeter confidence={investigation.confidence} />
			</span>
			<span className="w-18 shrink-0 max-sm:hidden">
				<SeverityBadge severity={investigationSeverity(investigation)} />
			</span>
			<span className="w-24 shrink-0 max-lg:hidden">
				<InvestigationStatusBadge status={investigation.status} />
			</span>
			<time
				dateTime={investigation.updated_at}
				title={new Date(toEpochMs(investigation.updated_at)).toLocaleString()}
				className="w-13 shrink-0 text-right text-xs text-muted-foreground"
			>
				{formatRelativeTime(investigation.updated_at)}
			</time>
		</li>
	)
}

/**
 * The row's second line. A running pass says how far through the fan-out it is
 * rather than a generic "gathering evidence…" — that is the one thing someone
 * watching a live investigation actually wants from a list.
 */
function RowFinding({
	investigation,
	finding,
}: {
	investigation: V2Investigation
	finding: ReturnType<typeof investigationFinding>
}) {
	if (finding.kind === "pending" && hasFanout(investigation)) {
		const tally = lensTally(placeholderLenses(investigation))
		return (
			<span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
				<span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
				<span className="truncate">
					{tally.reported} of {tally.total} lenses reported · validator blocked
				</span>
			</span>
		)
	}
	if (finding.kind === "none") {
		return <span className="text-xs text-muted-foreground/60">—</span>
	}
	return (
		<span
			className={cn(
				"flex min-w-0 items-center gap-1.5 text-xs",
				finding.kind === "failure" ? "text-destructive" : "text-muted-foreground",
			)}
			title={finding.text}
		>
			{finding.kind === "pending" ? (
				<span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
			) : null}
			<span className="truncate">{finding.text}</span>
		</span>
	)
}

/** Ghosts the real row rhythm, so the list doesn't reflow when rows land. */
export function InvestigationTableSkeleton() {
	return (
		<ul aria-label="Loading investigations" className="flex flex-col">
			{Array.from({ length: 5 }, (_, index) => (
				<li key={index} className="flex items-center gap-3.5 border-b px-4 py-3.5 last:border-b-0">
					<Skeleton className="size-3.5 shrink-0 rounded-full" />
					<div className="flex min-w-0 flex-1 flex-col gap-2">
						<Skeleton className="h-3.5 w-[45%]" />
						<Skeleton className="h-3 w-[70%]" />
					</div>
					<Skeleton className="h-3 w-20 shrink-0 max-md:hidden" />
					<Skeleton className="h-4 w-14 shrink-0 max-sm:hidden" />
					<Skeleton className="h-4 w-20 shrink-0 max-lg:hidden" />
					<Skeleton className="h-3 w-10 shrink-0" />
				</li>
			))}
		</ul>
	)
}
