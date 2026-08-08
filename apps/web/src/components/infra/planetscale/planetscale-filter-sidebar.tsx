import { useMemo } from "react"

import { FilterSection, SearchableFilterSection } from "@/components/filters/filter-section"
import {
	FilterSidebarBody,
	FilterSidebarFrame,
	FilterSidebarHeader,
} from "@/components/filters/filter-sidebar"
import type { BranchCandidate } from "./branch-selection"
import {
	BRANCH_ROLE_LABEL,
	BRANCH_STATE_LABEL,
	FILTER_SECTION_LABEL,
	branchRoleOf,
	branchStateOf,
	hasActiveFilters,
	type BranchRole,
	type BranchState,
	type PlanetScaleFilters,
} from "./filters"

/**
 * Branch facets for the database drill-in.
 *
 * Unlike the Cloudflare sidebar there is no server facet endpoint, and there
 * doesn't need to be: `candidates` is already the complete branch universe
 * (inventory ∪ metric rollups ∪ the scrape target's include/exclude globs), so
 * the options are a `useMemo` over data the page has in hand. That also means
 * this sidebar has no loading state of its own — it inherits the page's.
 *
 * Counts are branches, not traffic: on a database with thirty `pr-*` branches
 * "how many are excluded" is the question the sidebar is being asked.
 */
export function PlanetScaleFilterSidebar({
	candidates,
	filters,
	onFilterChange,
	onClear,
}: {
	candidates: ReadonlyArray<BranchCandidate>
	filters: PlanetScaleFilters
	onFilterChange: (key: keyof PlanetScaleFilters, values: ReadonlyArray<string> | undefined) => void
	onClear: () => void
}) {
	const facets = useMemo(() => {
		const branches = candidates.map((candidate) => ({ name: candidate.name, count: 1 }))
		const states = new Map<BranchState, number>()
		const roles = new Map<BranchRole, number>()
		for (const candidate of candidates) {
			const state = branchStateOf(candidate)
			const role = branchRoleOf(candidate)
			states.set(state, (states.get(state) ?? 0) + 1)
			roles.set(role, (roles.get(role) ?? 0) + 1)
		}
		return {
			branches,
			// Fixed vocabularies keep their canonical order rather than sorting by
			// count, so the sections don't reshuffle as branches come and go.
			states: (["ready", "provisioning", "excluded", "untracked"] as const)
				.filter((state) => states.has(state))
				.map((state) => ({ name: state, count: states.get(state)! })),
			roles: (["production", "development"] as const)
				.filter((role) => roles.has(role))
				.map((role) => ({ name: role, count: roles.get(role)! })),
		}
	}, [candidates])

	const change = (key: keyof PlanetScaleFilters) => (selected: string[]) =>
		// Empty selections drop out of the URL entirely rather than lingering
		// as `?branches=`.
		onFilterChange(key, selected.length === 0 ? undefined : selected)

	return (
		<FilterSidebarFrame>
			<FilterSidebarHeader canClear={hasActiveFilters(filters)} onClear={onClear} />
			<FilterSidebarBody>
				{/* Searchable and open by default: a database routinely carries one
				    branch per open pull request, so a flat list is unusable. */}
				<SearchableFilterSection
					title={FILTER_SECTION_LABEL.branches}
					options={facets.branches}
					selected={[...(filters.branches ?? [])]}
					onChange={change("branches")}
					defaultOpen
					maxVisible={8}
				/>
				<FilterSection
					title={FILTER_SECTION_LABEL.branchStates}
					options={facets.states}
					selected={[...(filters.branchStates ?? [])]}
					onChange={change("branchStates")}
					getOptionLabel={(name) => BRANCH_STATE_LABEL[name as BranchState] ?? name}
				/>
				<FilterSection
					title={FILTER_SECTION_LABEL.branchRoles}
					options={facets.roles}
					selected={[...(filters.branchRoles ?? [])]}
					onChange={change("branchRoles")}
					getOptionLabel={(name) => BRANCH_ROLE_LABEL[name as BranchRole] ?? name}
				/>
			</FilterSidebarBody>
		</FilterSidebarFrame>
	)
}
