import { Link } from "@tanstack/react-router"
import type { V2Investigation } from "@maple/domain/http/v2"
import { cn } from "@maple/ui/lib/utils"

import { hasFanout, placeholderLenses } from "./fanout-placeholder"

export const INVESTIGATION_TABS = ["overview", "evidence", "hypotheses", "chat", "transcript"] as const

export type InvestigationTab = (typeof INVESTIGATION_TABS)[number]

/**
 * The tabs are `<Link>`s, not a `Tabs` primitive. Three reasons: the strip is
 * pinned in `Sticky` while the panel scrolls in `Scroll`, so a single `Tabs` root
 * would have to straddle two layout regions; the active tab belongs in the URL so
 * a link to the Evidence tab survives a reload and a share; and links give
 * middle-click and browser history for free.
 */
export function InvestigationTabs({
	investigation,
	active,
}: {
	investigation: V2Investigation
	active: InvestigationTab
}) {
	const evidenceCount = investigation.report?.evidence.length ?? 0
	// At a fan-out of one there are no rivals to rank, so the section would be an
	// empty table with a heading — the design drops the tab entirely.
	const showHypotheses = hasFanout(investigation)
	const hypothesesCount = showHypotheses ? placeholderLenses(investigation).length : 0

	const tabs: ReadonlyArray<{ value: InvestigationTab; label: string; count?: number }> = [
		{ value: "overview", label: "Overview" },
		...(evidenceCount > 0
			? [{ value: "evidence" as const, label: "Evidence", count: evidenceCount }]
			: []),
		...(showHypotheses
			? [{ value: "hypotheses" as const, label: "Hypotheses", count: hypothesesCount }]
			: []),
		{ value: "chat", label: "Chat" },
		{ value: "transcript", label: "Transcript" },
	]

	return (
		// Full-bleed out of the sticky area's `p-4` and flush to its bottom edge, so
		// the underline reads as the boundary between header and content instead of
		// a rule floating 16px above one.
		<div
			role="tablist"
			aria-label="Investigation sections"
			className="-mx-4 -mb-4 flex items-center gap-6 overflow-x-auto border-b px-4"
		>
			{tabs.map((tab) => {
				const isActive = tab.value === active
				return (
					<Link
						key={tab.value}
						role="tab"
						aria-selected={isActive}
						to="/investigations/$id"
						params={{ id: investigation.id }}
						// `overview` is the default, so it drops out of the URL entirely.
						search={{ tab: tab.value === "overview" ? undefined : tab.value }}
						className={cn(
							"-mb-px flex h-[34px] shrink-0 items-center gap-1.5 border-b-2 text-sm transition-colors",
							isActive
								? "border-primary font-medium text-foreground"
								: "border-transparent text-muted-foreground hover:text-foreground",
						)}
					>
						{tab.label}
						{tab.count === undefined ? null : (
							<span className="text-xs text-muted-foreground tabular-nums">{tab.count}</span>
						)}
					</Link>
				)
			})}
		</div>
	)
}
