import { Link } from "@tanstack/react-router"

import type { ErrorIssueId } from "@maple/domain/http"
import { cn } from "@maple/ui/lib/utils"

export const ISSUE_TABS = ["overview", "occurrences", "activity"] as const

export type IssueTab = (typeof ISSUE_TABS)[number]

/**
 * The page's three questions, split.
 *
 * The body was seven sections in one `space-y-8` stack, each titled with the
 * same 10px eyebrow — so the sample traces, which is where you go the moment you
 * have read the message, sat below the activity log, the incidents table and the
 * anomalies list. Splitting them puts each one tab-click from the header instead
 * of a scroll away, and lets the Overview stop competing with itself.
 *
 * `<Link>`s rather than the `Tabs` primitive, for the reasons
 * `investigations/investigation-tabs.tsx` gives: the strip is pinned in `Sticky`
 * while the panel scrolls in `Scroll`, so one `Tabs` root would straddle two
 * layout regions; the active tab belongs in the URL; and links give middle-click
 * and history for free.
 */
export function IssueTabs({
	issueId,
	active,
	occurrenceCount,
	activityCount,
	showOccurrences,
}: {
	issueId: ErrorIssueId
	active: IssueTab
	occurrenceCount: number
	activityCount: number
	/** Alert- and integration-backed issues have no fingerprint samples to show,
	 *  so the tab is absent rather than empty. */
	showOccurrences: boolean
}) {
	const tabs: ReadonlyArray<{ value: IssueTab; label: string; count?: number }> = [
		{ value: "overview", label: "Overview" },
		...(showOccurrences
			? [{ value: "occurrences" as const, label: "Occurrences", count: occurrenceCount }]
			: []),
		{ value: "activity", label: "Activity", count: activityCount },
	]

	return (
		// Full-bleed out of the sticky area's `p-4` and flush to its bottom edge, so
		// the underline reads as the boundary between header and content rather than
		// a rule floating above one.
		<div
			role="tablist"
			aria-label="Issue sections"
			className="-mx-4 -mb-4 flex items-center gap-6 overflow-x-auto border-b px-4"
		>
			{tabs.map((tab) => {
				const isActive = tab.value === active
				return (
					<Link
						key={tab.value}
						role="tab"
						aria-selected={isActive}
						to="/errors/issues/$issueId"
						params={{ issueId }}
						// Merged, not replaced: the time range lives in the same search
						// object, and a tab switch that dropped it would silently reset the
						// window the chart and the samples are scoped to.
						search={(prev: Record<string, unknown>) => ({
							...prev,
							// `overview` is the default, so it drops out of the URL entirely.
							tab: tab.value === "overview" ? undefined : tab.value,
						})}
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
