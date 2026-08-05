import { describe, expect, it } from "vitest"

import type { BranchCandidate } from "./branch-selection"
import {
	activeFilterChips,
	applyBranchFilters,
	branchRoleOf,
	branchStateOf,
	filtersFromSearch,
	hasActiveFilters,
	soleSelectedBranch,
	toggleFilterValue,
} from "./filters"

const candidate = (over: Partial<BranchCandidate> & { name: string }): BranchCandidate => ({
	production: false,
	ready: true,
	stat: null,
	excluded: false,
	unknownToInventory: false,
	...over,
})

describe("filtersFromSearch", () => {
	it("reads the plural vocabulary", () => {
		expect(filtersFromSearch({ branches: ["main", "staging"] })).toEqual({
			branches: ["main", "staging"],
		})
	})

	it("decodes the legacy ?branch= link as a one-element selection", () => {
		// Shareable links predate the filter vocabulary and must keep resolving.
		expect(filtersFromSearch({ branch: "main" })).toEqual({ branches: ["main"] })
	})

	it("lets the plural vocabulary win when both are present", () => {
		expect(filtersFromSearch({ branch: "main", branches: ["staging"] })).toEqual({
			branches: ["staging"],
		})
	})

	it("drops empty values so they never linger in the URL", () => {
		expect(filtersFromSearch({ branches: [], branchContains: "", branch: "" })).toEqual({})
	})
})

describe("toggleFilterValue", () => {
	it("adds, removes, and collapses to undefined on the last removal", () => {
		expect(toggleFilterValue(undefined, "main")).toEqual(["main"])
		expect(toggleFilterValue(["main"], "staging")).toEqual(["main", "staging"])
		expect(toggleFilterValue(["main", "staging"], "main")).toEqual(["staging"])
		// undefined, not [] — an empty array would linger as ?branches= in the URL.
		expect(toggleFilterValue(["main"], "main")).toBeUndefined()
	})
})

describe("activeFilterChips", () => {
	it("emits one removable chip per selected value", () => {
		const chips = activeFilterChips({ branches: ["main", "pr-1"], branchStates: ["excluded"] })
		expect(chips.map((chip) => chip.label)).toEqual(["branch:main", "branch:pr-1", "state:excluded"])
	})

	it("renders a substring filter with its own prefix", () => {
		expect(activeFilterChips({ branchContains: "pr-" })[0]?.label).toBe("branch~pr-")
	})

	it("is empty for no filters", () => {
		expect(activeFilterChips({})).toEqual([])
		expect(hasActiveFilters({})).toBe(false)
	})
})

describe("branchStateOf", () => {
	it("prefers excluded over every other state", () => {
		// Excluded is what explains a permanent dash, so it outranks the rest.
		expect(branchStateOf(candidate({ name: "pr-1", excluded: true, ready: false }))).toBe("excluded")
		expect(branchStateOf(candidate({ name: "pr-1", excluded: true, unknownToInventory: true }))).toBe(
			"excluded",
		)
	})

	it("distinguishes provisioning from ready and untracked", () => {
		expect(branchStateOf(candidate({ name: "a", ready: false }))).toBe("provisioning")
		expect(branchStateOf(candidate({ name: "b", unknownToInventory: true }))).toBe("untracked")
		expect(branchStateOf(candidate({ name: "c" }))).toBe("ready")
	})
})

describe("branchRoleOf", () => {
	it("splits production from everything else", () => {
		expect(branchRoleOf(candidate({ name: "main", production: true }))).toBe("production")
		expect(branchRoleOf(candidate({ name: "pr-1" }))).toBe("development")
	})
})

describe("applyBranchFilters", () => {
	const all = [
		candidate({ name: "main", production: true }),
		candidate({ name: "staging" }),
		candidate({ name: "pr-1", excluded: true }),
		candidate({ name: "pr-2", ready: false }),
	]

	it("returns everything when nothing is selected", () => {
		expect(applyBranchFilters(all, {}).map((c) => c.name)).toEqual(["main", "staging", "pr-1", "pr-2"])
	})

	it("narrows by name, state, and role", () => {
		expect(applyBranchFilters(all, { branches: ["main", "pr-2"] }).map((c) => c.name)).toEqual([
			"main",
			"pr-2",
		])
		expect(applyBranchFilters(all, { branchStates: ["excluded"] }).map((c) => c.name)).toEqual(["pr-1"])
		expect(applyBranchFilters(all, { branchRoles: ["production"] }).map((c) => c.name)).toEqual(["main"])
	})

	it("intersects multiple filters", () => {
		expect(
			applyBranchFilters(all, { branchRoles: ["development"], branchStates: ["ready"] }).map(
				(c) => c.name,
			),
		).toEqual(["staging"])
	})

	it("matches the substring filter case-insensitively", () => {
		expect(applyBranchFilters(all, { branchContains: "PR-" }).map((c) => c.name)).toEqual([
			"pr-1",
			"pr-2",
		])
	})
})

describe("soleSelectedBranch", () => {
	it("resolves exactly one selection", () => {
		expect(soleSelectedBranch({ branches: ["main"] })).toBe("main")
	})

	it("refuses to pick one of several — the endpoints take one branch or all", () => {
		expect(soleSelectedBranch({ branches: ["main", "staging"] })).toBeNull()
		expect(soleSelectedBranch({})).toBeNull()
	})
})
