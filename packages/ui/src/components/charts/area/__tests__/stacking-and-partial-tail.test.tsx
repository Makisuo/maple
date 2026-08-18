import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderAreaChart } from "../query-builder-area-chart"

// jsdom has no ResizeObserver and lays nothing out. The chart only needs the
// observer to exist and a non-zero box to draw into; PlotFrame degrades to the
// SVG renderer here (no Canvas 2D context), which is what makes the marks
// inspectable as real paths and circles.
beforeAll(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: 800,
		bottom: 400,
		width: 800,
		height: 400,
		toJSON: () => ({}),
	})
})

afterEach(cleanup)

/** Two constant series, every bucket closed. Stacked they total 100. */
function twoSeriesRows() {
	const hour = 3_600_000
	// Ends two hours ago, so no bucket's end is in the future and nothing is
	// in flight to muddy the geometry.
	const start = Math.floor(Date.now() / hour) * hour - 8 * hour
	return Array.from({ length: 6 }, (_, index) => ({
		bucket: new Date(start + index * hour).toISOString(),
		lower: 30,
		upper: 70,
	}))
}

/**
 * The dashboard shape: hourly buckets anchored to wall-clock now, with NO
 * `partial` flag — `query-builder-timeseries` does not send one, so the trailing
 * in-flight bucket is found by comparing each bucket's end against the clock.
 */
function dashboardRows() {
	const hour = 3_600_000
	const currentBucketStart = Math.floor(Date.now() / hour) * hour
	return Array.from({ length: 13 }, (_, index) => ({
		bucket: new Date(currentBucketStart - (12 - index) * hour).toISOString(),
		"demo-api": 900 + Math.round(180 * Math.sin(index / 2)),
	}))
}

const axisTickLabels = (container: HTMLElement): string[] =>
	[...container.querySelectorAll("text")].map((node) => node.textContent ?? "")

function dashedPaths(container: HTMLElement): string[] {
	return [...container.querySelectorAll("path[stroke-dasharray]")]
		.map((path) => path.getAttribute("stroke-dasharray") ?? "")
		.filter((value) => value !== "" && value !== "none" && !value.startsWith("0 "))
}

/**
 * The y pixel of every focus dot.
 *
 * `whenFocused` emits a circle per datum into a `visibility: hidden` focus layer
 * rather than skipping the unfocused ones, so their positions are readable
 * without driving a pointer — which is the only way to check a stacked dot's
 * offset in jsdom.
 */
function focusDotYs(container: HTMLElement): number[] {
	return [...container.querySelectorAll(".ts-chart__focus-layer circle")]
		.map((circle) => Number(circle.getAttribute("cy")))
		.filter((value) => Number.isFinite(value))
}

/** Every y coordinate in an area band's closed outline, in path order. */
function bandYs(container: HTMLElement): number[][] {
	return [...container.querySelectorAll(".ts-chart__area path")].map((path) =>
		[...(path.getAttribute("d") ?? "").matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((match) =>
			Number(match[2]),
		),
	)
}

describe("query-builder area: stacking", () => {
	it("widens the y domain to the stack total", () => {
		const rows = twoSeriesRows()

		const unstacked = render(<QueryBuilderAreaChart data={rows} />)
		// 30 and 70 side by side: the axis tops out at 70.
		expect(axisTickLabels(unstacked.container)).not.toContain("100")
		unstacked.unmount()

		const stackedChart = render(<QueryBuilderAreaChart data={rows} stacked />)
		expect(axisTickLabels(stackedChart.container)).toContain("100")
	})

	it("puts the upper band's focus dot at the stacked offset, not its raw value", () => {
		const rows = twoSeriesRows()
		// `softMax` pins BOTH arms to the same [0, 100] domain, so the only thing
		// that can move a dot is the stacking itself rather than a rescaled axis.
		const unstacked = render(<QueryBuilderAreaChart data={rows} softMax={100} />)
		const unstackedTop = Math.min(...focusDotYs(unstacked.container))
		unstacked.unmount()

		const stackedChart = render(<QueryBuilderAreaChart data={rows} softMax={100} stacked />)
		const stackedTop = Math.min(...focusDotYs(stackedChart.container))

		// Smaller y is higher up the plot. Unstacked, the highest dot sits at 70;
		// stacked, the upper band's dot rides on top of the lower one at 100.
		expect(stackedTop).toBeLessThan(unstackedTop)
	})

	it("floors the upper band on the lower one rather than on the axis", () => {
		const rows = twoSeriesRows()

		// Unstacked, both bands fill from the axis, so both outlines close on the
		// same baseline pixel.
		const unstacked = render(<QueryBuilderAreaChart data={rows} softMax={100} />)
		const [lowerFlat, upperFlat] = bandYs(unstacked.container)
		expect(Math.max(...lowerFlat)).toBe(Math.max(...upperFlat))
		unstacked.unmount()

		// Stacked, the upper band's floor IS the lower band's top edge — the
		// property that makes the offsets a stack rather than two overlays.
		const stackedChart = render(<QueryBuilderAreaChart data={rows} softMax={100} stacked />)
		const [lower, upper] = bandYs(stackedChart.container)
		expect(Math.max(...upper)).toBe(Math.min(...lower))
		expect(Math.max(...lower)).toBeGreaterThan(Math.max(...upper))
	})
})

describe("query-builder area: trailing partial bucket", () => {
	it("draws the in-flight tail with a dashed edge", () => {
		const { container } = render(<QueryBuilderAreaChart data={dashboardRows()} />)
		expect(dashedPaths(container).length).toBeGreaterThan(0)
	})

	it("draws a dashed edge on a stacked tail too, where the closed run has none", () => {
		const rows = dashboardRows().map((row) => ({ ...row, "config-api": 120 }))
		const { container } = render(<QueryBuilderAreaChart data={rows} stacked />)
		// One dashed edge per visible series, and nothing dashed over the closed
		// run — a stacked band's closed edge would outline the whole silhouette.
		expect(dashedPaths(container)).toHaveLength(2)
	})

	it("draws nothing dashed when every bucket has closed", () => {
		const { container } = render(<QueryBuilderAreaChart data={twoSeriesRows()} />)
		expect(dashedPaths(container)).toHaveLength(0)
	})

	it("keeps point dots off the in-flight tail", () => {
		const rows = dashboardRows()
		const { container } = render(<QueryBuilderAreaChart data={rows} showPoints />)
		const pointDots = [...container.querySelectorAll("circle")].filter(
			(circle) => circle.getAttribute("r") === "2.5",
		)
		// 13 buckets, the last in flight: dots on the 12 that closed. A dashboard
		// tile's tail is one bucket wide, so a dot at each end would fill the
		// dashes in and the tail would read as a closed band.
		expect(pointDots).toHaveLength(rows.length - 1)
	})
})
