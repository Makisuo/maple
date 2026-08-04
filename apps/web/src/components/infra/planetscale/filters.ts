// Filter vocabulary for the PlanetScale database drill-in.
//
// Structurally a sibling of `cloudflare/filters.ts`, with one deliberate
// difference: there is no `ignoredFilters` plumbing. Cloudflare needs it because
// its poller stores single-dimension slices, so a path filter genuinely cannot
// narrow a cache chart. PlanetScale's gauges carry `planetscale_database_name`
// AND `planetscale_branch_name` on every datapoint, so every branch filter is
// applicable to every panel. The honesty problem here is different and narrower
// — see `branch-scope.tsx`.

import { Schema } from "effect"
import { OptionalStringArrayParam } from "@/lib/search-params"
import type { BranchCandidate } from "./branch-selection"

/** URL search-param fields. Spread into a route's `validateSearch` schema. */
export const planetscaleFilterSearchFields = {
	branches: OptionalStringArrayParam,
	branchStates: OptionalStringArrayParam,
	branchRoles: OptionalStringArrayParam,
	branchContains: Schema.optional(Schema.String),
}

export interface PlanetScaleFilters {
	branches?: ReadonlyArray<string>
	branchStates?: ReadonlyArray<string>
	branchRoles?: ReadonlyArray<string>
	branchContains?: string
}

export type PlanetScaleFilterKey = keyof PlanetScaleFilters

/** Short on purpose — these render inside 10px mono chips. */
export const FILTER_CHIP_LABEL: Record<PlanetScaleFilterKey, string> = {
	branches: "branch",
	branchStates: "state",
	branchRoles: "role",
	branchContains: "branch~",
}

export const FILTER_SECTION_LABEL: Record<PlanetScaleFilterKey, string> = {
	branches: "Branch",
	branchStates: "State",
	branchRoles: "Role",
	branchContains: "Branch contains",
}

const FILTER_KEYS = Object.keys(FILTER_CHIP_LABEL) as ReadonlyArray<PlanetScaleFilterKey>

/**
 * Pull the filter fields out of a route's search object.
 *
 * `?branch=` (singular) is the drill-in's original, documented shareable-link
 * contract. It is decoded here as a one-element `branches` selection and never
 * written back, so every link shared before this vocabulary existed still
 * resolves to the branch its sender was looking at.
 */
export const filtersFromSearch = (search: Record<string, unknown>): PlanetScaleFilters => {
	const out: PlanetScaleFilters = {}
	for (const key of FILTER_KEYS) {
		const value = search[key]
		if (key === "branchContains") {
			if (typeof value === "string" && value !== "") out.branchContains = value
		} else if (Array.isArray(value) && value.length > 0) {
			out[key] = value as ReadonlyArray<string>
		}
	}
	if (out.branches === undefined) {
		const legacy = search.branch
		if (typeof legacy === "string" && legacy !== "") out.branches = [legacy]
	}
	return out
}

export interface ActiveFilterChip {
	readonly key: PlanetScaleFilterKey
	readonly value: string
	/** What the chip reads, e.g. `branch:main`. */
	readonly label: string
}

export const activeFilterChips = (filters: PlanetScaleFilters): ReadonlyArray<ActiveFilterChip> => {
	const chips: Array<ActiveFilterChip> = []
	for (const key of FILTER_KEYS) {
		if (key === "branchContains") {
			if (filters.branchContains) {
				chips.push({
					key,
					value: filters.branchContains,
					label: `${FILTER_CHIP_LABEL[key]}${filters.branchContains}`,
				})
			}
			continue
		}
		for (const value of filters[key] ?? []) {
			chips.push({ key, value, label: `${FILTER_CHIP_LABEL[key]}:${value}` })
		}
	}
	return chips
}

export const hasActiveFilters = (filters: PlanetScaleFilters): boolean =>
	activeFilterChips(filters).length > 0

/** Toggle one value in a multi-select filter; undefined when the last value is removed. */
export const toggleFilterValue = (
	current: ReadonlyArray<string> | undefined,
	value: string,
): ReadonlyArray<string> | undefined => {
	const set = new Set(current ?? [])
	if (set.has(value)) set.delete(value)
	else set.add(value)
	return set.size === 0 ? undefined : [...set]
}

/**
 * The four lifecycle states a branch row can carry. Every one already exists as
 * a `BranchCandidate` field and is already rendered as a badge — the sidebar
 * just makes them selectable.
 */
export type BranchState = "ready" | "provisioning" | "excluded" | "untracked"

export const branchStateOf = (candidate: BranchCandidate): BranchState => {
	// Order matters: an excluded branch is excluded whatever else is true of it,
	// and that is the state that explains its permanent dash.
	if (candidate.excluded) return "excluded"
	if (candidate.unknownToInventory) return "untracked"
	return candidate.ready ? "ready" : "provisioning"
}

export const BRANCH_STATE_LABEL: Record<BranchState, string> = {
	ready: "Ready",
	provisioning: "Provisioning",
	excluded: "Excluded",
	untracked: "Not in inventory",
}

export type BranchRole = "production" | "development"

export const branchRoleOf = (candidate: BranchCandidate): BranchRole =>
	candidate.production ? "production" : "development"

export const BRANCH_ROLE_LABEL: Record<BranchRole, string> = {
	production: "Production",
	development: "Development",
}

/** Apply the filters to the merged branch list. Pure — the sidebar needs no server facets. */
export function applyBranchFilters(
	candidates: ReadonlyArray<BranchCandidate>,
	filters: PlanetScaleFilters,
): ReadonlyArray<BranchCandidate> {
	const contains = filters.branchContains?.toLowerCase() ?? ""
	return candidates.filter((candidate) => {
		if (filters.branches !== undefined && !filters.branches.includes(candidate.name)) return false
		if (filters.branchStates !== undefined && !filters.branchStates.includes(branchStateOf(candidate))) {
			return false
		}
		if (filters.branchRoles !== undefined && !filters.branchRoles.includes(branchRoleOf(candidate))) {
			return false
		}
		if (contains !== "" && !candidate.name.toLowerCase().includes(contains)) return false
		return true
	})
}

/**
 * The single branch the charts and Query Insights can actually be scoped to.
 *
 * Both of those endpoints take one branch or the whole database — so a
 * two-branch selection has no faithful rendering, and this returns null rather
 * than silently picking one. `branch-scope.tsx` is what says so on screen.
 */
export const soleSelectedBranch = (filters: PlanetScaleFilters): string | null =>
	filters.branches !== undefined && filters.branches.length === 1 ? filters.branches[0]! : null
