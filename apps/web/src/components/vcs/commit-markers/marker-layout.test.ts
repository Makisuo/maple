import { describe, expect, it } from "vitest"

import {
	buildCommitMarkers,
	EDGE_INSET,
	estimateLabelWidth,
	layoutMarkerLabels,
	MAX_LABEL_WIDTH,
	type PositionedMarker,
	type ReleasePoint,
} from "./marker-layout"

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)
const SHA_C = "c".repeat(40)
const SHA_D = "d".repeat(40)

// Five-minute buckets starting at a fixed instant.
const T0 = Date.UTC(2026, 5, 27, 10, 0, 0)
const STEP = 5 * 60 * 1000
const iso = (n: number) => new Date(T0 + n * STEP).toISOString()
const CHART = [iso(0), iso(1), iso(2), iso(3)]

describe("buildCommitMarkers", () => {
	it("returns nothing without data", () => {
		expect(buildCommitMarkers([], CHART)).toEqual([])
		expect(buildCommitMarkers([{ bucket: iso(0), commitSha: SHA_A, count: 1 }], [])).toEqual([])
	})

	it("suppresses a single-version window entirely (baseline exclusion)", () => {
		// One version serving the whole window: it was (as far as the data shows)
		// deployed before the window opened, so there is no deploy to mark.
		const releases: ReleasePoint[] = [
			{ bucket: iso(0), commitSha: SHA_A, count: 100 },
			{ bucket: iso(1), commitSha: SHA_A, count: 120 },
			{ bucket: iso(2), commitSha: SHA_A, count: 90 },
		]
		expect(buildCommitMarkers(releases, CHART)).toEqual([])
	})

	it("excludes the baseline commit but marks the ones deployed after it", () => {
		const releases: ReleasePoint[] = [
			{ bucket: iso(0), commitSha: SHA_A, count: 100 },
			{ bucket: iso(1), commitSha: SHA_A, count: 80 },
			{ bucket: iso(1), commitSha: SHA_B, count: 30 },
			{ bucket: iso(2), commitSha: SHA_B, count: 200 },
		]
		const markers = buildCommitMarkers(releases, CHART)
		// A was already running in the earliest bucket → excluded; B is a real deploy.
		expect(markers).toHaveLength(1)
		expect(markers[0].bucket).toBe(iso(1))
		expect(markers[0].commits).toEqual([{ sha: SHA_B, count: 30 }])
		// Default label is the SHORT sha for a 40-hex commit — the host overrides it
		// with the resolved message; the full sha stays available in the hover card.
		expect(markers[0].label).toBe(SHA_B.slice(0, 7))
	})

	it("excludes EVERY commit first seen in the baseline bucket, not just one", () => {
		// Two versions already overlapping at window start (e.g. a rollout in flight):
		// neither deploy was witnessed inside the window, so neither gets a dash.
		const releases: ReleasePoint[] = [
			{ bucket: iso(0), commitSha: SHA_A, count: 100 },
			{ bucket: iso(0), commitSha: SHA_B, count: 40 },
			{ bucket: iso(2), commitSha: SHA_C, count: 60 },
		]
		const markers = buildCommitMarkers(releases, CHART)
		expect(markers).toHaveLength(1)
		expect(markers[0].commits).toEqual([{ sha: SHA_C, count: 60 }])
	})

	it("groups multiple new commits in one bucket, representative (highest count) first", () => {
		const releases: ReleasePoint[] = [
			{ bucket: iso(0), commitSha: SHA_A, count: 100 },
			{ bucket: iso(2), commitSha: SHA_C, count: 10 },
			{ bucket: iso(2), commitSha: SHA_D, count: 50 },
		]
		const markers = buildCommitMarkers(releases, CHART)
		expect(markers).toHaveLength(1) // A is the baseline → only the iso(2) group
		const grouped = markers.find((m) => m.bucket === iso(2))!
		expect(grouped.commits).toEqual([
			{ sha: SHA_D, count: 50 },
			{ sha: SHA_C, count: 10 },
		])
		// Representative drives the label (short sha by default for a 40-hex commit).
		expect(grouped.label).toBe(SHA_D.slice(0, 7))
	})

	it("uses each commit's earliest bucket as its deploy point", () => {
		const releases: ReleasePoint[] = [
			{ bucket: iso(0), commitSha: SHA_A, count: 100 },
			{ bucket: iso(2), commitSha: SHA_B, count: 5 },
			{ bucket: iso(1), commitSha: SHA_B, count: 40 }, // earlier sighting wins
		]
		const markers = buildCommitMarkers(releases, CHART)
		const b = markers.find((m) => m.commits.some((c) => c.sha === SHA_B))!
		expect(b.bucket).toBe(iso(1))
		expect(b.commits[0].count).toBe(40)
	})

	it("snaps Tinybird-formatted release buckets onto the ISO chart grid", () => {
		const tb = (n: number) => new Date(T0 + n * STEP).toISOString().replace("T", " ").slice(0, 19)
		const releases: ReleasePoint[] = [
			{ bucket: tb(0), commitSha: SHA_A, count: 100 },
			{ bucket: tb(2), commitSha: SHA_B, count: 30 },
		]
		const markers = buildCommitMarkers(releases, CHART)
		expect(markers.map((m) => m.bucket)).toEqual([iso(2)]) // snapped to a chart bucket
	})

	it("keeps a non-resolvable reference (short sha / tag) as its own marker + label", () => {
		const releases: ReleasePoint[] = [
			{ bucket: iso(0), commitSha: SHA_A, count: 200 }, // baseline, excluded
			{ bucket: iso(1), commitSha: "v1.2.3", count: 100 },
			{ bucket: iso(2), commitSha: "deadbeef", count: 40 },
		]
		const markers = buildCommitMarkers(releases, CHART)
		expect(markers).toHaveLength(2)
		// The full reference string is the default label (not pre-sliced); the
		// renderer truncates with CSS so even a long sha stays readable.
		expect(markers[0].label).toBe("v1.2.3")
		expect(markers[1].label).toBe("deadbeef")
	})
})

describe("layoutMarkerLabels", () => {
	const marker = (id: string, count = 1, label = "abc1234"): PositionedMarker["marker"] => ({
		bucket: id,
		label,
		commits: Array.from({ length: count }, (_, i) => ({ sha: `${id}-${i}`, count: 1 })),
	})
	const at = (id: string, x: number, count = 1): PositionedMarker => ({
		marker: marker(id, count),
		x,
	})

	it("sizes labels dynamically — a longer label is wider and so merges more", () => {
		// Same two dash positions, different label text. The collision test uses each
		// label's actual (dynamic) width, so a short sha keeps them separate while a long
		// subject (clamped to MAX_LABEL_WIDTH) is wide enough to swallow the neighbour.
		const positions = [
			{ id: "a", x: 40 },
			{ id: "b", x: 120 },
		]
		const layout = (label: string) =>
			layoutMarkerLabels(
				positions.map(({ id, x }) => ({ marker: marker(id, 1, label), x })),
				0,
				600,
			)
		const short = layout("abc1234")
		const long = layout("fix: a much longer commit subject")
		expect(short).toHaveLength(2) // narrow labels don't collide
		expect(long).toHaveLength(1) // wide label reaches its neighbour
		expect(long[0].boxWidth).toBeGreaterThan(short[0].boxWidth)
	})

	it("keeps well-separated markers as distinct labels", () => {
		const groups = layoutMarkerLabels([at("a", 20), at("b", 300)], 0, 600)
		expect(groups).toHaveLength(2)
		expect(groups.map((g) => g.dashXs)).toEqual([[20], [300]])
	})

	it("merges labels that would overlap and accumulates their commits + dashes", () => {
		const groups = layoutMarkerLabels([at("a", 20), at("b", 40), at("c", 360)], 0, 600)
		expect(groups).toHaveLength(2)
		// a and b collide (close x) → one label; c stands alone.
		expect(groups[0].dashXs).toEqual([20, 40])
		expect(groups[0].commits).toHaveLength(2)
		// The merged box spans both dashes so each connects straight up into it.
		expect(groups[0].boxLeft).toBeLessThanOrEqual(20)
		expect(groups[0].boxLeft + groups[0].boxWidth).toBeGreaterThanOrEqual(40)
		expect(groups[1].dashXs).toEqual([360])
	})

	it("keeps EVERY dash even when many markers pack tightly (dashes never dropped)", () => {
		// 12 markers tightly packed (10px apart). They merge into a few labels (a new
		// label is only drawn once there's room for one), but no dash is ever lost.
		const positioned = Array.from({ length: 12 }, (_, i) => at(`m${i}`, 20 + i * 10))
		const groups = layoutMarkerLabels(positioned, 0, 600)
		const totalDashes = groups.reduce((n, g) => n + g.dashXs.length, 0)
		const totalCommits = groups.reduce((n, g) => n + g.commits.length, 0)
		expect(totalDashes).toBe(12)
		expect(totalCommits).toBe(12)
		expect(groups.length).toBeLessThan(12) // some merging happened
	})

	it("merges two close dashes into one label that covers both", () => {
		// Two dashes close enough that the second falls under the first's label → one
		// label, both dashes kept and the box covers both so each connects straight up.
		const groups = layoutMarkerLabels([at("a", 20), at("b", 44)], 0, 600)
		expect(groups).toHaveLength(1)
		expect(groups[0].dashXs).toEqual([20, 44])
		expect(groups[0].boxLeft).toBeLessThanOrEqual(20)
		expect(groups[0].boxLeft + groups[0].boxWidth).toBeGreaterThanOrEqual(44)
	})

	it("offsets a new label to the right when centering would collide with the previous one", () => {
		// `a` sits alone; `b`'s dash clears `a`'s box (so it is NOT merged) but a
		// dash-centered `b` label would overlap `a`. It is shoved right to clear `a`,
		// while still covering its own dash — so it is offset, not centered.
		const groups = layoutMarkerLabels([at("a", 60), at("b", 110)], 0, 600)
		expect(groups).toHaveLength(2)
		const [a, b] = groups
		expect(b.boxLeft).toBeGreaterThanOrEqual(a.boxLeft + a.boxWidth) // cleared `a`
		expect(b.boxLeft).toBeLessThanOrEqual(110) // dash still under the label ...
		expect(b.boxLeft + b.boxWidth).toBeGreaterThanOrEqual(110)
		expect(b.boxLeft + b.boxWidth / 2).toBeGreaterThan(110) // ... but pushed right of centre
	})

	it("centers a lone chip on its dash", () => {
		const groups = layoutMarkerLabels([at("a", 300)], 0, 600)
		const g = groups[0]
		// the chip's horizontal centre sits on the dash x
		expect(Math.round(g.boxLeft + g.boxWidth / 2)).toBe(300)
	})

	it("reserves +N badge width for a fresh multi-commit marker (matches the merge path)", () => {
		// A single bucket holding several commits renders a `+N` badge, so its box must
		// be estimated with the badge included — the same `commits.length`-aware width
		// the merge path uses, not the badge-less single-commit width.
		const [lone] = layoutMarkerLabels([at("a", 300)], 0, 600)
		const [multi] = layoutMarkerLabels([at("b", 300, 3)], 0, 600)
		expect(multi.boxWidth).toBe(estimateLabelWidth("abc1234", 3))
		expect(multi.boxWidth).toBeGreaterThan(lone.boxWidth)
	})

	it("centers a merged label over its cluster's midpoint (clear of the edges)", () => {
		// Three close dashes (280, 300, 320) merge; with room on both sides the box
		// centres on the midpoint (300) and spans every dash so all three connect up.
		const groups = layoutMarkerLabels([at("a", 280), at("b", 300), at("c", 320)], 0, 600)
		expect(groups).toHaveLength(1)
		const g = groups[0]
		expect(g.dashXs).toEqual([280, 300, 320])
		expect(Math.round(g.boxLeft + g.boxWidth / 2)).toBe(300)
		expect(g.boxLeft).toBeLessThanOrEqual(280)
		expect(g.boxLeft + g.boxWidth).toBeGreaterThanOrEqual(320)
	})

	it("never lets two labels overlap (or leave the plot), however dense the markers", () => {
		// Sweep many densities in a plot wide enough to hold every dash. No label may
		// start before the previous one ends, and none may spill past the plot edges.
		const PLOT_RIGHT = 1800
		for (const step of [8, 14, 20, 33, 60, 120]) {
			const positioned = Array.from({ length: 14 }, (_, i) => at(`m${i}`, 12 + i * step))
			const groups = layoutMarkerLabels(positioned, 0, PLOT_RIGHT)
			for (let i = 0; i < groups.length; i++) {
				expect(groups[i].boxLeft).toBeGreaterThanOrEqual(0)
				expect(groups[i].boxLeft + groups[i].boxWidth).toBeLessThanOrEqual(PLOT_RIGHT)
				if (i > 0) {
					const prev = groups[i - 1]
					expect(groups[i].boxLeft).toBeGreaterThanOrEqual(prev.boxLeft + prev.boxWidth)
				}
			}
			// And every dash is still accounted for.
			expect(groups.reduce((n, g) => n + g.dashXs.length, 0)).toBe(14)
		}
	})

	it("never lets a wide label spill past the plot's right edge", () => {
		// A short label, then a WIDE (long-text) label whose dash sits near the right edge.
		// Clamped past the previous label it would overflow; instead it must shrink to fit
		// within bounds while staying clear of the previous label and covering its dash.
		const positioned: PositionedMarker[] = [
			{ marker: marker("a", 1, "abc1234"), x: 470 },
			{ marker: marker("b", 1, "a-very-long-resolved-commit-subject-line"), x: 595 },
		]
		const groups = layoutMarkerLabels(positioned, 0, 600)
		expect(groups).toHaveLength(2)
		for (const g of groups) {
			expect(g.boxLeft).toBeGreaterThanOrEqual(0)
			expect(g.boxLeft + g.boxWidth).toBeLessThanOrEqual(600) // in-bounds, not cut off
		}
		// No overlap with the previous label ...
		expect(groups[1].boxLeft).toBeGreaterThanOrEqual(groups[0].boxLeft + groups[0].boxWidth)
		// ... and the (shrunk) wide label still covers its own dash.
		expect(groups[1].boxLeft).toBeLessThanOrEqual(595)
		expect(groups[1].boxLeft + groups[1].boxWidth).toBeGreaterThanOrEqual(595)
	})

	it("folds a marker with no room before the right edge into the previous label", () => {
		// `b`'s dash (570) clears `a`'s label box, so it does NOT "hit" it — but it leaves
		// less than a minimum-width label of room before the edge (600). Rather than render
		// a sliver crammed against the edge, `b` folds into `a` (+1).
		const positioned: PositionedMarker[] = [
			{ marker: marker("a", 1, "abc1234"), x: 518 },
			{ marker: marker("b", 1, "abc1234"), x: 570 },
		]
		const groups = layoutMarkerLabels(positioned, 0, 600)
		expect(groups).toHaveLength(1)
		expect(groups[0].dashXs).toEqual([518, 570])
		expect(groups[0].boxLeft + groups[0].boxWidth).toBeLessThanOrEqual(600)
	})

	it("keeps every dash inset from the label edges (no corner connections)", () => {
		// A merged group well clear of the plot edges: every owned dash must sit at least
		// EDGE_INSET inside the box, so no vertical connects at a corner.
		const groups = layoutMarkerLabels([at("a", 280), at("b", 300), at("c", 320)], 0, 600)
		expect(groups).toHaveLength(1)
		const g = groups[0]
		for (const x of g.dashXs) {
			expect(x).toBeGreaterThanOrEqual(g.boxLeft + EDGE_INSET)
			expect(x).toBeLessThanOrEqual(g.boxLeft + g.boxWidth - EDGE_INSET)
		}
	})

	it("keeps the box within the plot's right edge", () => {
		const groups = layoutMarkerLabels([at("a", 595)], 0, 600)
		expect(groups[0].boxLeft + groups[0].boxWidth).toBeLessThanOrEqual(600)
	})

	it("covers every dash AND stays in-plot when a cluster hugs the right edge", () => {
		// Cluster pressed against the right edge: the box can't centre on the midpoint
		// without overflowing, so it slides left — but must still cover both dashes.
		const groups = layoutMarkerLabels([at("a", 560), at("b", 584)], 0, 600)
		expect(groups).toHaveLength(1)
		const g = groups[0]
		expect(g.boxLeft).toBeLessThanOrEqual(560) // leftmost dash covered
		expect(g.boxLeft + g.boxWidth).toBeGreaterThanOrEqual(584) // rightmost dash covered
		expect(g.boxLeft + g.boxWidth).toBeLessThanOrEqual(600) // still in-plot
		expect(g.boxLeft).toBeGreaterThanOrEqual(0)
	})

	it("covers every dash AND stays in-plot when a cluster hugs the left edge", () => {
		const groups = layoutMarkerLabels([at("a", 6), at("b", 30)], 0, 600)
		expect(groups).toHaveLength(1)
		const g = groups[0]
		expect(g.boxLeft).toBeLessThanOrEqual(6)
		expect(g.boxLeft + g.boxWidth).toBeGreaterThanOrEqual(30)
		expect(g.boxLeft).toBeGreaterThanOrEqual(0)
		expect(g.boxLeft + g.boxWidth).toBeLessThanOrEqual(600)
	})

	it("splits a run wider than one label into multiple labels (bounded width)", () => {
		// A long chain of dashes can't all hide under one max-width label, so the sweep
		// rolls over into a new label once a dash clears the previous one's box. Every
		// dash is kept, and each label covers the dashes it owns.
		const positioned = Array.from({ length: 8 }, (_, i) => at(`m${i}`, 40 + i * 24))
		const groups = layoutMarkerLabels(positioned, 0, 600)
		expect(groups.length).toBeGreaterThan(1) // bounded labels → more than one
		const totalDashes = groups.reduce((n, g) => n + g.dashXs.length, 0)
		expect(totalDashes).toBe(8) // no dash dropped
		for (const g of groups) {
			expect(g.boxLeft).toBeLessThanOrEqual(g.dashXs[0]) // leftmost owned dash covered
			expect(g.boxLeft + g.boxWidth).toBeGreaterThanOrEqual(g.dashXs[g.dashXs.length - 1])
		}
	})
})

describe("estimateLabelWidth", () => {
	it("adds width for the +N badge and clamps to bounds", () => {
		expect(estimateLabelWidth("abc1234", 1)).toBeLessThan(estimateLabelWidth("abc1234", 3))
		expect(estimateLabelWidth("", 1)).toBe(44) // min
		expect(estimateLabelWidth("x".repeat(200), 5)).toBe(MAX_LABEL_WIDTH) // max
	})
})
