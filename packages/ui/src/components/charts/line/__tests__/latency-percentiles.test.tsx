import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { LatencyLineChart } from "../latency-line-chart"

// jsdom has no ResizeObserver and lays nothing out. The chart only needs the
// observer to exist and a non-zero box to draw into; PlotFrame degrades to the
// SVG renderer here (no Canvas 2D context), which is what makes the marks
// inspectable as real paths.
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

/** Six closed hourly buckets, ending two hours ago so nothing is in flight. */
function closedRows() {
	const hour = 3_600_000
	const start = Math.floor(Date.now() / hour) * hour - 8 * hour
	return Array.from({ length: 6 }, (_, index) => ({
		bucket: new Date(start + index * hour).toISOString(),
		p50LatencyMs: 12 + index,
		p95LatencyMs: 45 + index,
		p99LatencyMs: 120 + index,
	}))
}

/**
 * The service-detail shape: hourly buckets anchored to wall-clock now, with no
 * `partial` flag — the warehouse does not send one, so the trailing in-flight
 * bucket is found by comparing each bucket's end against the clock.
 */
function liveRows() {
	const hour = 3_600_000
	const currentBucketStart = Math.floor(Date.now() / hour) * hour
	return Array.from({ length: 8 }, (_, index) => ({
		bucket: new Date(currentBucketStart - (7 - index) * hour).toISOString(),
		p50LatencyMs: 12 + index,
		p95LatencyMs: 45 + index,
		p99LatencyMs: 120 + index,
	}))
}

const linePaths = (container: HTMLElement) => [...container.querySelectorAll(".ts-chart__line path")]

const dashedLines = (container: HTMLElement) =>
	linePaths(container).filter((path) => {
		const dash = path.getAttribute("stroke-dasharray")
		return dash != null && dash !== "" && dash !== "none"
	})

const axisTickLabels = (container: HTMLElement): string[] =>
	[...container.querySelectorAll("text")].map((node) => node.textContent ?? "")

describe("latency line chart", () => {
	it("draws one line per percentile, each in its own resolved colour", () => {
		const { container } = render(<LatencyLineChart data={closedRows()} />)
		const strokes = linePaths(container).map((path) => path.getAttribute("stroke"))

		expect(strokes).toHaveLength(3)
		// jsdom resolves no stylesheet, so `usePlotColors` falls through to the
		// literals. What matters is that a LITERAL is what reached the definition:
		// a `var(--chart-p99)` would paint on SVG and paint nothing on canvas, and
		// `PlotFrame`'s dev assertion would have thrown before this line.
		expect(new Set(strokes).size).toBe(3)
		for (const stroke of strokes) expect(stroke).toMatch(/^#[0-9a-f]{6}$/i)
	})

	it("dashes the in-flight tail of every percentile", () => {
		const { container } = render(<LatencyLineChart data={liveRows()} />)
		// One dashed mark per series over the trailing slice, on top of the three
		// solid runs — `strokeDasharray` is a scalar on `lineY`, so a single mark
		// cannot change style mid-line.
		expect(dashedLines(container)).toHaveLength(3)
		expect(linePaths(container)).toHaveLength(6)
	})

	it("draws nothing dashed when every bucket has closed", () => {
		const { container } = render(<LatencyLineChart data={closedRows()} />)
		expect(dashedLines(container)).toHaveLength(0)
	})

	it("formats the y axis as latency rather than as bare numbers", () => {
		const { container } = render(<LatencyLineChart data={closedRows()} />)
		const labels = axisTickLabels(container)
		expect(labels.some((label) => label.endsWith("ms"))).toBe(true)
	})

	it("shows the percentile key only when the legend is asked for", () => {
		const hidden = render(<LatencyLineChart data={closedRows()} />)
		expect(hidden.queryByText("P95")).toBeNull()
		hidden.unmount()

		render(<LatencyLineChart data={closedRows()} legend="visible" />)
		for (const label of ["P50", "P95", "P99"]) {
			expect(screen.getByText(label)).toBeTruthy()
		}
	})

	it("drops rows whose bucket cannot be parsed instead of inventing an x position", () => {
		const clean = render(<LatencyLineChart data={closedRows()} />)
		const cleanLabels = axisTickLabels(clean.container)
		clean.unmount()

		// A row with no parseable bucket has no position on a time axis. Recharts
		// gave it a categorical slot, which silently invented one — and this row's
		// 9999ms would then have blown the y axis open.
		const rows = [...closedRows(), { bucket: "not-a-time", p50LatencyMs: 9_999 }]
		const { container } = render(<LatencyLineChart data={rows} />)
		expect(axisTickLabels(container)).toEqual(cleanLabels)
	})
})
