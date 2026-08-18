// @vitest-environment jsdom

import type { ResolvedScale } from "@tanstack/charts"
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { PlotRect } from "@maple/ui/components/plot/plot-frame"

import { CommitMarkersOverlay } from "../commit-markers-layer"
import type { CommitMarker } from "../marker-layout"

/**
 * The overlay takes its geometry as props, so the layout can be driven at known pixel
 * values. `CommitMarkersLayer` is the thin connector that reads the same two values off
 * `PlotFrame`'s stores; a real chart resolves no scales at all in jsdom (nothing has a
 * layout), so going through it would test nothing.
 */
afterEach(cleanup)

// Matches the layer's own hitbox half-width; a dash's `left` is its pixel minus this.
const DASH_HIT = 5

const PLOT: PlotRect = { x: 40, y: 10, width: 600, height: 200 }

const DOMAIN_START = Date.UTC(2026, 0, 1, 0, 0, 0)
const DOMAIN_END = Date.UTC(2026, 0, 1, 6, 0, 0)

/** A time scale over the six-hour domain, mapping linearly across the plot width. */
function timeScale(): ResolvedScale {
	return {
		id: "x",
		type: "time",
		domain: [new Date(DOMAIN_START), new Date(DOMAIN_END)],
		map: (value: unknown) => {
			const ms = value instanceof Date ? value.getTime() : Number(value)
			return PLOT.x + (PLOT.width * (ms - DOMAIN_START)) / (DOMAIN_END - DOMAIN_START)
		},
		ticks: [],
		bandwidth: 0,
	}
}

/** UTC hours past the domain start, in the tz-less warehouse bucket format. */
function bucket(hoursPastStart: number): string {
	return new Date(DOMAIN_START + hoursPastStart * 3_600_000).toISOString().replace("T", " ").slice(0, 19)
}

function pixelFor(hoursPastStart: number): number {
	return PLOT.x + (PLOT.width * hoursPastStart) / 6
}

function marker(hoursPastStart: number, label: string, shas: string[] = [label]): CommitMarker {
	return {
		bucket: bucket(hoursPastStart),
		label,
		commits: shas.map((sha) => ({ sha, count: 1 })),
	}
}

function mount(
	markers: CommitMarker[],
	plot: { rect?: PlotRect | null; xScale?: ResolvedScale | null } = {},
) {
	const view = render(
		<CommitMarkersOverlay
			markers={markers}
			plotRect={plot.rect === undefined ? PLOT : plot.rect}
			xScale={plot.xScale === undefined ? timeScale() : plot.xScale}
		/>,
	)
	return {
		dashes: Array.from(view.container.querySelectorAll<HTMLElement>("[data-commit-marker-dash]")),
		labels: Array.from(view.container.querySelectorAll<HTMLElement>("[data-commit-marker-label]")),
		container: view.container,
	}
}

describe("CommitMarkersOverlay", () => {
	describe("degrades safely without a plot", () => {
		it("renders nothing outside a PlotFrame, where neither value resolves", () => {
			const { container } = mount([marker(1, "abc1234")], { rect: null, xScale: null })
			expect(container.innerHTML).toBe("")
		})

		it("renders nothing before the scales resolve", () => {
			const { container } = mount([marker(1, "abc1234")], { xScale: null })
			expect(container.innerHTML).toBe("")
		})

		it("renders nothing before the rect resolves", () => {
			const { container } = mount([marker(1, "abc1234")], { rect: null })
			expect(container.innerHTML).toBe("")
		})

		it("renders nothing for an empty marker set", () => {
			const { container } = mount([])
			expect(container.innerHTML).toBe("")
		})

		it("skips a marker the scale maps to a non-finite pixel", () => {
			const { container } = mount([marker(1, "abc1234")], {
				xScale: { ...timeScale(), map: () => Number.NaN },
			})
			expect(container.innerHTML).toBe("")
		})

		it("skips a marker whose bucket a time scale cannot parse", () => {
			const unparseable: CommitMarker = {
				bucket: "not-a-date",
				label: "x",
				commits: [{ sha: "x", count: 1 }],
			}
			const { container } = mount([unparseable])
			expect(container.innerHTML).toBe("")
		})
	})

	describe("positions markers through the resolved scale", () => {
		it("places a dash at the pixel the x scale maps its bucket to", () => {
			const { dashes } = mount([marker(1, "abc1234")])

			expect(dashes).toHaveLength(1)
			// 1h into a 6h domain across a 600px plot starting at x=40.
			expect(pixelFor(1)).toBe(140)
			expect(dashes[0].style.left).toBe(`${pixelFor(1) - DASH_HIT}px`)
		})

		/**
		 * The bucket → scale-input conversion is chosen from the domain's own shape, so a
		 * chart still on a categorical x axis gets the raw bucket string rather than a
		 * parsed `Date` the band scale would not recognise.
		 */
		it("hands a categorical scale the bucket string verbatim", () => {
			const seen: unknown[] = []
			const { dashes } = mount([marker(1, "abc1234")], {
				xScale: {
					id: "x",
					type: "band",
					domain: [bucket(0), bucket(1), bucket(2)],
					map: (value: unknown) => {
						seen.push(value)
						return 200
					},
					ticks: [],
					bandwidth: 20,
				},
			})

			expect(seen).toEqual([bucket(1)])
			expect(dashes[0].style.left).toBe(`${200 - DASH_HIT}px`)
		})

		it("hands a numeric scale epoch milliseconds", () => {
			const seen: unknown[] = []
			mount([marker(1, "abc1234")], {
				xScale: {
					id: "x",
					type: "linear",
					domain: [DOMAIN_START, DOMAIN_END],
					map: (value: unknown) => {
						seen.push(value)
						return 200
					},
					ticks: [],
					bandwidth: 0,
				},
			})

			expect(seen).toEqual([DOMAIN_START + 3_600_000])
		})

		it("spans the dash from above the plot top down through the plot", () => {
			const { dashes } = mount([marker(1, "abc1234")])

			// A labelled dash rises LABEL_GAP (4) above the plot to meet the chip.
			expect(dashes[0].style.top).toBe(`${PLOT.y - 4}px`)
			expect(dashes[0].style.height).toBe(`${PLOT.height + 4}px`)
		})

		/**
		 * The chip row sits above the plot's top edge. Under Recharts that needed the
		 * `foreignObject` box extended upward or the chip would paint but never hover;
		 * here a negative `top` is all it takes, and `pointer-events-auto` is what opts
		 * back into the pointer that `PlotFrame`'s overlay slot declines.
		 */
		it("draws the label chip above the plot top and lets it take the pointer", () => {
			const { labels } = mount([marker(1, "abc1234")])

			// plotTop (10) − LABEL_HEIGHT (18) − LABEL_GAP (4).
			expect(labels[0].style.top).toBe("-12px")
			expect(labels[0].className).toContain("pointer-events-auto")
		})
	})

	describe("label layout", () => {
		it("gives well-separated markers their own chips", () => {
			const { dashes, labels } = mount([marker(0, "aaaaaaa"), marker(3, "bbbbbbb")])

			expect(dashes).toHaveLength(2)
			expect(labels.map((el) => el.textContent)).toEqual(["aaaaaaa", "bbbbbbb"])
			// No merge, so neither chip carries a `+N` badge.
			expect(labels.some((el) => el.textContent?.includes("+"))).toBe(false)
		})

		it("merges neighbouring markers into one chip with a +N badge", () => {
			const { dashes, labels } = mount([marker(1, "aaaaaaa"), marker(1.01, "bbbbbbb")])

			// Both dashes stay — only the chips merge.
			expect(dashes).toHaveLength(2)
			expect(labels).toHaveLength(1)
			expect(labels[0].textContent).toBe("aaaaaaa+1")
		})

		it("counts every commit of a merged group in the badge", () => {
			const { labels } = mount([marker(1, "aaaaaaa", ["aaaaaaa", "ccccccc"]), marker(1.01, "bbbbbbb")])

			expect(labels[0].textContent).toBe("aaaaaaa+2")
		})

		it("renders the chip at the width the placement reserved, covering every dash", () => {
			const { labels, dashes } = mount([marker(1, "aaaaaaa"), marker(1.01, "bbbbbbb")])

			const left = Number.parseFloat(labels[0].style.left)
			const width = Number.parseFloat(labels[0].style.width)
			// Every dash the group owns connects INSIDE the box, never at a corner.
			for (const dash of dashes) {
				const dashX = Number.parseFloat(dash.style.left) + DASH_HIT
				expect(dashX).toBeGreaterThan(left)
				expect(dashX).toBeLessThan(left + width)
			}
		})

		/**
		 * Past `MAX_LABELED_MARKERS` the chip row is noise, so the layer drops to
		 * dashes-only and the hover cards stay the detail path.
		 */
		it("drops the chip row entirely under heavy deploy volume", () => {
			const many = Array.from({ length: 12 }, (_, i) => marker(i * 0.4, `sha${i}`))
			const { dashes, labels } = mount(many)

			expect(dashes).toHaveLength(12)
			expect(labels).toHaveLength(0)
		})

		it("spans each dash exactly the plot height in dashes-only mode", () => {
			const many = Array.from({ length: 12 }, (_, i) => marker(i * 0.4, `sha${i}`))
			const { dashes } = mount(many)

			expect(dashes[0].style.top).toBe(`${PLOT.y}px`)
			expect(dashes[0].style.height).toBe(`${PLOT.height}px`)
		})
	})

	/**
	 * The layer is mounted into `PlotFrame`'s `pointer-events-none` overlay slot, so it
	 * must not take the pointer while idle — otherwise every chart carrying deploy
	 * markers would lose its own hover across the whole plot.
	 */
	it("leaves the plot's own hover alone while idle", () => {
		const { container } = mount([marker(1, "abc1234")])
		const root = container.querySelector("[data-commit-markers]")

		expect(root?.className).toContain("pointer-events-none")
	})
})
