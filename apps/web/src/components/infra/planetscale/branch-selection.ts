// Branch resolution for the PlanetScale database drill-in.
//
// A PlanetScale database is not one thing: production plus one branch per open
// pull request, which in practice means tens of branches, nearly all idle. Two
// consequences drive this module:
//
//  1. The default scope has to be the production branch. Falling back to
//     "whichever branch has the most connections" would be right by accident on
//     a healthy database and wrong the moment production goes quiet.
//  2. The branch list has to come from the inventory UNION the metric rollups.
//     Building it from metrics alone silently drops branches excluded from
//     scraping or asleep, leaving no way to tell "no such branch" from "no data".
//
// Pure — no React, no atoms — so the precedence rules are testable on their own.

import type { PlanetScaleBranchSummary } from "@maple/domain/http"
import type { PlanetScaleBranchStat } from "@/api/warehouse/service-map"

export interface BranchCandidate {
	readonly name: string
	readonly production: boolean
	readonly ready: boolean
	/** Null when the inventory knows this branch but the window has no metrics for it. */
	readonly stat: PlanetScaleBranchStat | null
	/** Matched the scrape target's exclude globs — explains a permanent dash. */
	readonly excluded: boolean
	/** In the metric rollups but not the inventory (inventory lag, or just deleted). */
	readonly unknownToInventory: boolean
}

/**
 * PlanetScale's branch filters are shell-style globs (`pr-*`, `preview-*`).
 * Anchored, `*` only — matching what the scraper's discovery config applies.
 */
export function matchesGlob(pattern: string, value: string): boolean {
	if (pattern === "") return false
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
	return new RegExp(`^${escaped}$`).test(value)
}

const isExcluded = (
	name: string,
	includeBranches: ReadonlyArray<string>,
	excludeBranches: ReadonlyArray<string>,
): boolean => {
	// An include list, when present, is authoritative: anything outside it is excluded.
	if (includeBranches.length > 0 && !includeBranches.some((p) => matchesGlob(p, name))) return true
	return excludeBranches.some((p) => matchesGlob(p, name))
}

/**
 * One row per branch the operator could reasonably ask about: everything the
 * inventory knows, plus anything the rollups reported that the inventory hasn't
 * caught up with.
 */
export function mergeBranchCandidates(
	inventoryBranches: ReadonlyArray<PlanetScaleBranchSummary>,
	stats: ReadonlyArray<PlanetScaleBranchStat>,
	includeBranches: ReadonlyArray<string> = [],
	excludeBranches: ReadonlyArray<string> = [],
): ReadonlyArray<BranchCandidate> {
	const statByName = new Map(stats.map((row) => [row.branch, row]))
	const candidates: BranchCandidate[] = inventoryBranches.map((branch) => ({
		name: branch.name,
		production: branch.production,
		ready: branch.ready,
		stat: statByName.get(branch.name) ?? null,
		excluded: isExcluded(branch.name, includeBranches, excludeBranches),
		unknownToInventory: false,
	}))

	const known = new Set(candidates.map((c) => c.name))
	for (const row of stats) {
		if (row.branch === "" || known.has(row.branch)) continue
		known.add(row.branch)
		candidates.push({
			name: row.branch,
			production: false,
			// Metrics are flowing, so it is serving — the inventory just hasn't listed it.
			ready: true,
			stat: row,
			excluded: false,
			unknownToInventory: true,
		})
	}
	return candidates
}

export type BranchResolution =
	| { readonly kind: "empty" }
	| { readonly kind: "unknown"; readonly name: string; readonly fallback: BranchCandidate | null }
	| {
			readonly kind: "resolved"
			readonly branch: BranchCandidate
			readonly role: "production" | "selected" | "busiest"
	  }

const connectionsOf = (candidate: BranchCandidate) => candidate.stat?.connectionsAvg ?? -1

/** Production first, then busiest, then alphabetical — a total order with no ties. */
export function defaultBranch(
	candidates: ReadonlyArray<BranchCandidate>,
): { readonly branch: BranchCandidate; readonly role: "production" | "busiest" } | null {
	if (candidates.length === 0) return null
	const production = candidates.filter((c) => c.production)
	if (production.length > 0) {
		// A promote in flight can briefly show two production branches; the busier
		// one is the one actually serving. Both keep their badge in the table —
		// this picks a default, it does not hide the anomaly.
		const branch = [...production].sort(
			(a, b) => connectionsOf(b) - connectionsOf(a) || a.name.localeCompare(b.name),
		)[0]!
		return { branch, role: "production" }
	}
	const branch = [...candidates].sort(
		(a, b) => connectionsOf(b) - connectionsOf(a) || a.name.localeCompare(b.name),
	)[0]!
	return { branch, role: "busiest" }
}

/**
 * Resolve the scope for the page. A `requested` name that no longer exists
 * resolves to `unknown` rather than silently snapping to the default: the URL is
 * shareable, and quietly showing a different branch's numbers under the
 * requested name is worse than saying the branch is gone.
 */
export function resolveSelectedBranch(
	candidates: ReadonlyArray<BranchCandidate>,
	requested: string | undefined,
): BranchResolution {
	if (candidates.length === 0) return { kind: "empty" }
	const fallback = defaultBranch(candidates)

	if (requested !== undefined && requested !== "") {
		const match = candidates.find((c) => c.name === requested)
		if (match === undefined) {
			return { kind: "unknown", name: requested, fallback: fallback?.branch ?? null }
		}
		return {
			kind: "resolved",
			branch: match,
			role: match.production ? "production" : "selected",
		}
	}

	if (fallback === null) return { kind: "empty" }
	return { kind: "resolved", branch: fallback.branch, role: fallback.role }
}

/** Why a branch shows dashes. Distinct causes, distinct fixes. */
export function absenceReason(candidate: BranchCandidate): "excluded" | "no-data" | null {
	if (candidate.stat !== null) return null
	return candidate.excluded ? "excluded" : "no-data"
}

/**
 * Branch order for the selector and the table: production, then branches with
 * traffic, then the idle tail alphabetically. On a database with thirty `pr-*`
 * branches this is the difference between a usable list and a wall of zeros.
 */
export function orderBranches(
	candidates: ReadonlyArray<BranchCandidate>,
): ReadonlyArray<BranchCandidate> {
	return [...candidates].sort((a, b) => {
		if (a.production !== b.production) return a.production ? -1 : 1
		const diff = connectionsOf(b) - connectionsOf(a)
		if (diff !== 0) return diff
		return a.name.localeCompare(b.name)
	})
}
