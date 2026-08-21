import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderLineChart } from "../query-builder-line-chart"

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

/**
 * The dashboard shape: hourly buckets anchored to wall-clock now, with NO
 * `partial` flag — `query-builder-timeseries` does not send one, so the trailing
 * in-flight bucket is found by comparing each bucket's end against the clock.
 */
function dashboardRows(lastValue: number | null) {
	const hour = 3_600_000
	const currentBucketStart = Math.floor(Date.now() / hour) * hour
	return Array.from({ length: 13 }, (_, index) => ({
		bucket: new Date(currentBucketStart - (12 - index) * hour).toISOString(),
		"demo-api": index === 12 ? (lastValue ?? 0) : 900 + Math.round(180 * Math.sin(index / 2)),
	}))
}

function dashedPaths(container: HTMLElement): string[] {
	return [...container.querySelectorAll("path[stroke-dasharray]")]
		.map((path) => path.getAttribute("stroke-dasharray") ?? "")
		.filter((value) => value !== "" && value !== "none" && !value.startsWith("0 "))
}

describe("query-builder line: trailing partial bucket", () => {
	it("draws the in-flight bucket dashed", () => {
		const { container } = render(<QueryBuilderLineChart data={dashboardRows(240)} />)
		expect(dashedPaths(container).length).toBeGreaterThan(0)
	})

	it("draws nothing dashed when every bucket has closed", () => {
		const hour = 3_600_000
		// Ends two hours ago, so no bucket's end is in the future.
		const closedStart = Math.floor(Date.now() / hour) * hour - 3 * hour
		const rows = Array.from({ length: 6 }, (_, index) => ({
			bucket: new Date(closedStart - (5 - index) * hour).toISOString(),
			"demo-api": 100 + index,
		}))
		const { container } = render(<QueryBuilderLineChart data={rows} />)
		expect(dashedPaths(container)).toHaveLength(0)
	})
})

describe("dots do not mask the dashed tail", () => {
	it("draws point dots on the closed buckets only", () => {
		const rows = dashboardRows(240)
		const { container } = render(<QueryBuilderLineChart data={rows} showPoints />)
		// Point dots are r=2.5; the focus dots (r=3.5, sized to 0 until focused) are
		// a separate layer and are counted out by the radius filter.
		const pointDots = [...container.querySelectorAll("circle")].filter(
			(circle) => circle.getAttribute("r") === "2.5",
		)
		// 13 buckets, the last in flight: dots on the 12 that closed.
		//
		// Recharts got this for free — its solid series was null across the
		// in-flight region, so the dot renderer never ran there. It matters more
		// than it looks: a dashboard tile's partial tail is one bucket wide, so a
		// dot at each end fills the dashes in and the tail reads as solid.
		expect(pointDots).toHaveLength(rows.length - 1)
	})
})
