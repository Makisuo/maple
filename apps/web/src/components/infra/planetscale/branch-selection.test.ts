import { describe, expect, it } from "vitest"

import type { PlanetScaleBranchStat } from "@/api/warehouse/service-map"
import {
	absenceReason,
	defaultBranch,
	isExcluded,
	matchesGlob,
	mergeBranchCandidates,
	orderBranches,
	resolveSelectedBranch,
	type BranchCandidate,
} from "./branch-selection"

const branch = (name: string, production = false, ready = true) => ({ id: name, name, production, ready })

const stat = (name: string, connectionsAvg: number): PlanetScaleBranchStat => ({
	database: "maple",
	branch: name,
	connectionsAvg,
	connectionsMax: connectionsAvg,
	cpuMaxPercent: 0,
	memMaxPercent: 0,
	replicaLagMaxSeconds: 0,
	storageUsedPercent: null,
})

const candidate = (over: Partial<BranchCandidate> & { name: string }): BranchCandidate => ({
	production: false,
	ready: true,
	stat: null,
	excluded: false,
	unknownToInventory: false,
	...over,
})

describe("matchesGlob", () => {
	it("anchors the pattern", () => {
		expect(matchesGlob("pr-*", "pr-246")).toBe(true)
		expect(matchesGlob("pr-*", "not-pr-246")).toBe(false)
		expect(matchesGlob("main", "main")).toBe(true)
		expect(matchesGlob("main", "maintenance")).toBe(false)
	})

	it("treats regex metacharacters as literals", () => {
		expect(matchesGlob("v1.0", "v1.0")).toBe(true)
		expect(matchesGlob("v1.0", "v1x0")).toBe(false)
	})

	// `?` is a single-character wildcard on the scraper side. The client used to
	// escape it as a literal, so a `pr-?` filter collected different branches
	// than the preview showed. Both now share @maple/domain/glob.
	it("treats `?` as a one-character wildcard, matching the scraper", () => {
		expect(matchesGlob("pr-?", "pr-1")).toBe(true)
		expect(matchesGlob("pr-?", "pr-12")).toBe(false)
		expect(matchesGlob("pr-?", "pr-")).toBe(false)
		expect(matchesGlob("main?", "main?")).toBe(true)
		expect(matchesGlob("main?", "mainx")).toBe(true)
	})

	it("matches nothing for an empty pattern", () => {
		expect(matchesGlob("", "main")).toBe(false)
		expect(matchesGlob("", "")).toBe(false)
	})
})

describe("isExcluded", () => {
	it("treats a non-empty include list as authoritative", () => {
		expect(isExcluded("main", ["main", "staging"], [])).toBe(false)
		expect(isExcluded("pr-1", ["main", "staging"], [])).toBe(true)
	})

	it("applies exclusions on top of an include list", () => {
		expect(isExcluded("pr-1", ["pr-*"], ["pr-1"])).toBe(true)
		expect(isExcluded("pr-2", ["pr-*"], ["pr-1"])).toBe(false)
	})

	it("collects everything when both lists are empty", () => {
		expect(isExcluded("anything", [], [])).toBe(false)
	})
})

describe("mergeBranchCandidates", () => {
	it("keeps inventory branches that reported no metrics", () => {
		const merged = mergeBranchCandidates([branch("main", true), branch("pr-1")], [stat("main", 18)])
		expect(merged.map((c) => c.name)).toEqual(["main", "pr-1"])
		expect(merged[1]!.stat).toBeNull()
	})

	it("adds branches the rollups saw but the inventory hasn't listed", () => {
		const merged = mergeBranchCandidates([branch("main", true)], [stat("main", 18), stat("pr-9", 3)])
		const extra = merged.find((c) => c.name === "pr-9")
		expect(extra?.unknownToInventory).toBe(true)
		expect(extra?.stat?.connectionsAvg).toBe(3)
	})

	it("flags branches the scrape target excludes", () => {
		const merged = mergeBranchCandidates([branch("main", true), branch("pr-246")], [], [], ["pr-*"])
		expect(merged.find((c) => c.name === "main")?.excluded).toBe(false)
		expect(merged.find((c) => c.name === "pr-246")?.excluded).toBe(true)
	})

	it("treats an include list as authoritative", () => {
		const merged = mergeBranchCandidates([branch("main", true), branch("staging")], [], ["main"], [])
		expect(merged.find((c) => c.name === "staging")?.excluded).toBe(true)
	})

	it("ignores blank branch labels from the warehouse", () => {
		const merged = mergeBranchCandidates([branch("main", true)], [stat("", 0)])
		expect(merged.map((c) => c.name)).toEqual(["main"])
	})
})

describe("defaultBranch", () => {
	it("prefers production even when a dev branch is busier", () => {
		const result = defaultBranch([
			candidate({ name: "pr-1", stat: stat("pr-1", 400) }),
			candidate({ name: "main", production: true, stat: stat("main", 2) }),
		])
		expect(result?.branch.name).toBe("main")
		expect(result?.role).toBe("production")
	})

	it("picks the busier one while two branches claim production", () => {
		const result = defaultBranch([
			candidate({ name: "old-main", production: true, stat: stat("old-main", 1) }),
			candidate({ name: "new-main", production: true, stat: stat("new-main", 50) }),
		])
		expect(result?.branch.name).toBe("new-main")
	})

	it("falls back to the busiest branch when none is production", () => {
		const result = defaultBranch([
			candidate({ name: "b", stat: stat("b", 5) }),
			candidate({ name: "a", stat: stat("a", 40) }),
		])
		expect(result?.branch.name).toBe("a")
		expect(result?.role).toBe("busiest")
	})

	it("is alphabetical when nothing has metrics", () => {
		expect(defaultBranch([candidate({ name: "zeta" }), candidate({ name: "alpha" })])?.branch.name).toBe(
			"alpha",
		)
	})

	it("still resolves a production branch that is provisioning", () => {
		const result = defaultBranch([candidate({ name: "main", production: true, ready: false })])
		expect(result?.branch.name).toBe("main")
	})

	it("returns null with no branches", () => {
		expect(defaultBranch([])).toBeNull()
	})
})

describe("resolveSelectedBranch", () => {
	const candidates = [
		candidate({ name: "main", production: true, stat: stat("main", 18) }),
		candidate({ name: "pr-246", stat: stat("pr-246", 0) }),
	]

	it("defaults to production with no request", () => {
		const resolved = resolveSelectedBranch(candidates, undefined)
		expect(resolved).toMatchObject({ kind: "resolved", role: "production" })
	})

	it("honours an explicit request", () => {
		const resolved = resolveSelectedBranch(candidates, "pr-246")
		expect(resolved).toMatchObject({ kind: "resolved", role: "selected" })
	})

	it("reports an unknown branch instead of snapping to the default", () => {
		const resolved = resolveSelectedBranch(candidates, "pr-999")
		expect(resolved.kind).toBe("unknown")
		if (resolved.kind !== "unknown") throw new Error("expected unknown")
		expect(resolved.name).toBe("pr-999")
		// The recovery target is offered, but not silently substituted.
		expect(resolved.fallback?.name).toBe("main")
	})

	it("treats an empty request as absent", () => {
		expect(resolveSelectedBranch(candidates, "")).toMatchObject({ role: "production" })
	})

	it("is empty with no branches", () => {
		expect(resolveSelectedBranch([], undefined)).toEqual({ kind: "empty" })
		expect(resolveSelectedBranch([], "main")).toEqual({ kind: "empty" })
	})
})

describe("absenceReason", () => {
	it("separates an excluded branch from one with no data", () => {
		expect(absenceReason(candidate({ name: "pr-1", excluded: true }))).toBe("excluded")
		expect(absenceReason(candidate({ name: "pr-2" }))).toBe("no-data")
		expect(absenceReason(candidate({ name: "main", stat: stat("main", 1) }))).toBeNull()
	})
})

describe("orderBranches", () => {
	it("puts production first, then busiest, then the idle tail alphabetically", () => {
		const ordered = orderBranches([
			candidate({ name: "pr-9" }),
			candidate({ name: "pr-2", stat: stat("pr-2", 7) }),
			candidate({ name: "main", production: true }),
			candidate({ name: "pr-1" }),
		])
		expect(ordered.map((c) => c.name)).toEqual(["main", "pr-2", "pr-1", "pr-9"])
	})
})
