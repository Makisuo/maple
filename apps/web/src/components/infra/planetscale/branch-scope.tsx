// What a PlanetScale panel is actually scoped to.
//
// This is NOT a PanelScope clone. Cloudflare needs `ignoredFilters` because its
// poller stores single-dimension slices, so a path filter genuinely cannot
// narrow a cache chart. PlanetScale's gauges carry both
// `planetscale_database_name` and `planetscale_branch_name` on every datapoint,
// so every branch filter is applicable to every panel. There is no partial
// application to confess.
//
// What IS worth confessing is narrower, and it's a fact about our query shape
// rather than an invented dimension limit: the timeseries endpoint takes one
// branch or the whole database, and Query Insights takes exactly one branch. So
// a two-branch selection has no faithful rendering, and rather than silently
// pick one, the panel says which answer it fell back to.

import { ScopeChip } from "../primitives/scope-chip"

export type BranchScopeSurface = "chart" | "insights"

const FALLBACK_EXPLANATION: Record<BranchScopeSurface, string> = {
	chart: "PlanetScale reports these gauges per branch, but the history endpoint answers one branch or the whole database — so this shows every branch combined.",
	insights:
		"PlanetScale's Query Insights API answers one branch at a time, so this shows the resolved branch only.",
}

/**
 * @param selected Branch names the page is filtered to. Empty means all.
 * @param resolved The branch actually queried, when the surface fell back to one.
 */
export function PlanetScaleBranchScope({
	selected,
	resolved,
	surface,
}: {
	selected: ReadonlyArray<string>
	resolved?: string | null
	surface: BranchScopeSurface
}) {
	if (selected.length === 0) {
		return (
			<ScopeChip tone="muted" explanation="Every branch in this database, combined.">
				all branches
			</ScopeChip>
		)
	}

	// Exactly one: the gauge really is that branch's. No caveat earned.
	if (selected.length === 1) return <ScopeChip>{selected[0]}</ScopeChip>

	const shown = selected.slice(0, 2).join(", ")
	const extra = selected.length - 2
	return (
		<span className="flex flex-wrap items-center gap-1">
			<ScopeChip>
				{shown}
				{extra > 0 ? ` +${extra}` : ""}
			</ScopeChip>
			<ScopeChip tone="muted" explanation={FALLBACK_EXPLANATION[surface]}>
				{surface === "chart" ? "showing all branches" : `showing ${resolved ?? "the default branch"}`}
			</ScopeChip>
		</span>
	)
}
