import type { DashboardSection, DashboardWidget } from "@/components/dashboard-builder/types"

// Per-viewer section view state, encoded in the URL.
//
// The split is deliberate: the *stored default* collapse state lives on the
// document (`section.collapsed`), while a given viewer's overrides live here, so
// one person collapsing a group on their screen never changes what the next
// person sees. Same for the active tab.
//
// Everything is a flat comma-joined string rather than a JSON blob — these end
// up in URLs people paste to each other, and `?tab=overview:latency` is both
// readable and impossible to fail parsing.
//
// Pure and React-free so the precedence rules are testable without a router.

export interface SectionViewSearch {
	collapsed?: string | undefined
	expanded?: string | undefined
	tab?: string | undefined
	widget?: string | undefined
}

const PAIR_SEPARATOR = ":"

export function parseIdList(value: string | undefined): ReadonlySet<string> {
	if (!value) return new Set()
	return new Set(
		value
			.split(",")
			.map((id) => id.trim())
			.filter((id) => id.length > 0),
	)
}

const formatIdList = (ids: Iterable<string>): string => [...ids].join(",")

/**
 * Parse `?tab=sectionId:tabId,sectionId:tabId`.
 *
 * Never throws: a hand-edited URL yields whatever pairs are well-formed and
 * silently drops the rest, because a malformed tab reference is not a reason to
 * fail the whole dashboard route.
 */
export function parseActiveTabs(value: string | undefined): ReadonlyMap<string, string> {
	const pairs = new Map<string, string>()
	if (!value) return pairs
	for (const entry of value.split(",")) {
		const separator = entry.indexOf(PAIR_SEPARATOR)
		if (separator <= 0) continue
		const sectionId = entry.slice(0, separator).trim()
		const tabId = entry.slice(separator + 1).trim()
		if (sectionId.length === 0 || tabId.length === 0) continue
		pairs.set(sectionId, tabId)
	}
	return pairs
}

const formatActiveTabs = (pairs: ReadonlyMap<string, string>): string =>
	[...pairs].map(([sectionId, tabId]) => `${sectionId}${PAIR_SEPARATOR}${tabId}`).join(",")

/**
 * Whether a section renders collapsed for this viewer.
 *
 * Precedence: an explicit expand wins, then an explicit collapse, then the
 * document's stored default. `expanded` beating `collapsed` matters for the
 * widget deep link, which force-expands the section holding the target tile.
 */
export function isSectionCollapsed(section: DashboardSection, search: SectionViewSearch): boolean {
	if (parseIdList(search.expanded).has(section.id)) return false
	if (parseIdList(search.collapsed).has(section.id)) return true
	return section.collapsed ?? false
}

/** The tab a section shows for this viewer, falling back to its first tab. */
export function activeTabIdFor(section: DashboardSection, search: SectionViewSearch): string {
	const requested = parseActiveTabs(search.tab).get(section.id)
	if (requested !== undefined && section.tabs.some((tab) => tab.id === requested)) {
		return requested
	}
	return section.tabs[0]?.id ?? section.id
}

/**
 * Toggle a section's collapse for this viewer.
 *
 * Removing the id from the opposite list is load-bearing, not tidiness: without
 * it a section toggled back and forth accumulates in both lists, the URL grows
 * without bound, and `expanded` — which wins — permanently pins the section open.
 */
export function withSectionCollapsed(
	search: SectionViewSearch,
	sectionId: string,
	collapsed: boolean,
): SectionViewSearch {
	const expanded = new Set(parseIdList(search.expanded))
	const collapsedIds = new Set(parseIdList(search.collapsed))

	if (collapsed) {
		expanded.delete(sectionId)
		collapsedIds.add(sectionId)
	} else {
		collapsedIds.delete(sectionId)
		expanded.add(sectionId)
	}

	const next: SectionViewSearch = { ...search }
	// Drop the key entirely when empty, rather than leaving `?collapsed=` behind.
	if (expanded.size > 0) next.expanded = formatIdList(expanded)
	else delete next.expanded
	if (collapsedIds.size > 0) next.collapsed = formatIdList(collapsedIds)
	else delete next.collapsed
	return next
}

export function withActiveTab(
	search: SectionViewSearch,
	sectionId: string,
	tabId: string,
): SectionViewSearch {
	const pairs = new Map(parseActiveTabs(search.tab))
	pairs.set(sectionId, tabId)
	return { ...search, tab: formatActiveTabs(pairs) }
}

export interface ResolvedSectionView {
	/** Section ids rendering collapsed. */
	readonly collapsed: ReadonlySet<string>
	/** Active tab id per section. */
	readonly activeTabs: ReadonlyMap<string, string>
}

/**
 * Resolve every section's collapse and active tab in one pass, honouring a
 * `?widget=` deep link by force-expanding and tab-switching to the target.
 *
 * Deliberately a derivation rather than an effect: resolving the deep link after
 * mount would render the target's section collapsed, then expand it — mounting,
 * unmounting and remounting the tile, and firing its query twice.
 */
export function resolveSectionView(
	sections: ReadonlyArray<DashboardSection>,
	widgets: ReadonlyArray<DashboardWidget>,
	search: SectionViewSearch,
): ResolvedSectionView {
	const target =
		search.widget === undefined
			? undefined
			: widgets.find((widget) => widget.id === search.widget)

	const collapsed = new Set<string>()
	const activeTabs = new Map<string, string>()

	for (const section of sections) {
		const isTargetSection = target?.sectionId === section.id
		if (!isTargetSection && isSectionCollapsed(section, search)) {
			collapsed.add(section.id)
		}

		const linkedTab =
			isTargetSection && target?.tabId !== undefined && section.tabs.some((t) => t.id === target.tabId)
				? target.tabId
				: undefined
		activeTabs.set(section.id, linkedTab ?? activeTabIdFor(section, search))
	}

	return { collapsed, activeTabs }
}
