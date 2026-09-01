import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { ThroughputAreaChart } from "../throughput-area-chart"

// See `stacking-and-partial-tail.test.tsx` — jsdom has no ResizeObserver and no
// Canvas 2D context, so PlotFrame degrades to the SVG renderer and the marks
// become inspectable.
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

const HOUR = 3_600_000

/** Six closed hourly buckets, ending two hours ago. */
function rows(extra: (index: number) => Record<string, unknown> = () => ({})) {
	const start = Math.floor(Date.now() / HOUR) * HOUR - 8 * HOUR
	return Array.from({ length: 6 }, (_, index) => ({
		bucket: new Date(start + index * HOUR).toISOString(),
		throughput: 3_600,
		...extra(index),
	}))
}

const linePaths = (container: HTMLElement) => [...container.querySelectorAll(".ts-chart__line path")]

const axisTickLabels = (container: HTMLElement): string[] =>
	[...container.querySelectorAll("text")].map((node) => node.textContent ?? "")

/**
 * The y pixel of every focus dot, deduplicated.
 *
 * `whenFocused` emits a circle per datum into a `visibility: hidden` layer
 * rather than skipping the unfocused ones, so their positions are readable
 * without driving a pointer.
 */
function focusDotYs(container: HTMLElement): number[] {
	const values = [...container.querySelectorAll(".ts-chart__focus-layer circle")]
		.map((circle) => Number(circle.getAttribute("cy")))
		.filter((value) => Number.isFinite(value))
	return [...new Set(values)].sort((a, b) => a - b)
}

describe("throughput area chart: rate mode", () => {
	it("labels the axis per bucket by default and per second under rateMode", () => {
		const perBucket = render(<ThroughputAreaChart data={rows()} />)
		expect(axisTickLabels(perBucket.container).some((label) => label.endsWith("/h"))).toBe(true)
		perBucket.unmount()

		const perSecond = render(<ThroughputAreaChart data={rows()} rateMode="per_second" />)
		const labels = axisTickLabels(perSecond.container)
		expect(labels.some((label) => label.endsWith("/s"))).toBe(true)
		// 3600 per hour is 1 per second: the conversion is visible in the ticks,
		// not just in the suffix.
		expect(labels.some((label) => label.startsWith("1"))).toBe(true)
		expect(labels.some((label) => label.includes("3,600") || label.includes("3.6"))).toBe(false)
	})
})

describe("throughput area chart: derived error series", () => {
	it("treats errorRate as a fraction, not a percentage", () => {
		// Every request failed. `errorThroughput` is therefore EXACTLY `throughput`,
		// so the two series' focus dots land on the same pixel. A stray `/ 100`
		// would put the error line two orders of magnitude below the band, which is
		// the bug this pins down.
		const { container } = render(<ThroughputAreaChart data={rows(() => ({ errorRate: 1 }))} />)
		expect(focusDotYs(container)).toHaveLength(1)
	})

	it("plots the errors as a count on the throughput axis, not on a second one", () => {
		// ONE y axis: every tick carries the throughput unit and none is a
		// percentage. A right-hand rate axis was tried and read worse on a chart
		// this size — see `ERROR_KEY`.
		const { container } = render(<ThroughputAreaChart data={rows(() => ({ errorRate: 0.25 }))} />)
		const labels = axisTickLabels(container)
		expect(labels.some((label) => label.endsWith("/h"))).toBe(true)
		expect(labels.some((label) => label.endsWith("%"))).toBe(false)
	})

	it("positions the error line at its true share of the band", () => {
		// Throughput is fixed at 3,600/h in all three, so all three share one y
		// domain and the error values 900 / 1,800 / 2,700 are evenly spaced. On a
		// shared linear axis their pixels must be evenly spaced too — which is what
		// "the error line sits at its real fraction of the band" means, and what a
		// second axis or a rescaled series would break.
		const errorYFor = (errorRate: number) => {
			const view = render(<ThroughputAreaChart data={rows(() => ({ errorRate }))} />)
			// Two dots: throughput above, errors below. Larger y is lower down.
			const errorY = focusDotYs(view.container).at(-1) as number
			view.unmount()
			return errorY
		}

		const [low, mid, high] = [errorYFor(0.25), errorYFor(0.5), errorYFor(0.75)]
		// One decimal: `cy` is serialised rounded, so the two ~82.7px gaps differ in
		// the hundredths. Anything non-linear would be out by whole pixels.
		expect(low - mid).toBeCloseTo(mid - high, 1)
		// ...and a non-zero gap, so three identical positions cannot pass.
		expect(low - mid).toBeGreaterThan(1)
	})

	it("draws no error line, and no error key, when nothing failed", () => {
		const { container } = render(<ThroughputAreaChart data={rows(() => ({ errorRate: 0 }))} />)
		// The band's own top edge, and nothing else.
		expect(linePaths(container)).toHaveLength(1)
		expect(screen.queryByText(/Errors/)).toBeNull()
	})

	it("shows the key for the error line even when no legend was asked for", () => {
		// The dashed error line has no axis of its own, so it is unreadable without
		// a key — the legend appears for it whether or not the caller wanted one.
		render(<ThroughputAreaChart data={rows(() => ({ errorRate: 0.25 }))} />)
		expect(screen.getByText("Errors (/h)")).toBeTruthy()
	})
})

describe("throughput area chart: sampling", () => {
	it("marks the throughput key as an estimate and keeps the traced line out of it", () => {
		render(
			<ThroughputAreaChart
				data={rows(() => ({ hasSampling: true, tracedThroughput: 500 }))}
				legend="visible"
			/>,
		)
		expect(screen.getByText("~Throughput (/h)")).toBeTruthy()
		// The traced line is a reference, not a series to read off — under Recharts
		// it carried `legendType="none"` for the same reason.
		expect(screen.queryByText("Traced")).toBeNull()
	})

	it("draws the traced reference line only when traced rows exist", () => {
		const without = render(<ThroughputAreaChart data={rows()} />)
		expect(linePaths(without.container)).toHaveLength(1)
		without.unmount()

		const withTraced = render(<ThroughputAreaChart data={rows(() => ({ tracedThroughput: 500 }))} />)
		expect(linePaths(withTraced.container)).toHaveLength(2)
	})
})

describe("throughput area chart: trailing partial bucket", () => {
	it("splits the band and its edge at the in-flight boundary", () => {
		const currentBucketStart = Math.floor(Date.now() / HOUR) * HOUR
		const live = Array.from({ length: 8 }, (_, index) => ({
			bucket: new Date(currentBucketStart - (7 - index) * HOUR).toISOString(),
			throughput: 3_600 + index * 60,
		}))
		const { container } = render(<ThroughputAreaChart data={live} />)

		expect(container.querySelectorAll(".ts-chart__area path")).toHaveLength(2)
		const dashed = linePaths(container).filter((path) => {
			const dash = path.getAttribute("stroke-dasharray")
			return dash != null && dash !== "" && dash !== "none"
		})
		expect(dashed).toHaveLength(1)
	})
})
