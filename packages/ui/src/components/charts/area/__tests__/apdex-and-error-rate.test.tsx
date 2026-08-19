import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { ApdexAreaChart } from "../apdex-area-chart"
import { ErrorRateAreaChart, errorRateCeiling } from "../error-rate-area-chart"

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
function rows(value: (index: number) => Record<string, unknown>) {
	const start = Math.floor(Date.now() / HOUR) * HOUR - 8 * HOUR
	return Array.from({ length: 6 }, (_, index) => ({
		bucket: new Date(start + index * HOUR).toISOString(),
		...value(index),
	}))
}

const axisTickLabels = (container: HTMLElement): string[] =>
	[...container.querySelectorAll("text")].map((node) => node.textContent ?? "")

describe("apdex area chart", () => {
	it("pins the axis to the 0–1 score rather than to the data extent", () => {
		// A window of good hours must not rescale into looking like a bad one:
		// apdex is a score on a fixed scale, so both bounds are the scale's.
		const { container } = render(<ApdexAreaChart data={rows(() => ({ apdexScore: 0.94 }))} />)
		const labels = axisTickLabels(container)
		expect(labels).toContain("0")
		expect(labels).toContain("1")
	})

	it("draws a band with a top edge, and no baseline stroke around it", () => {
		const { container } = render(<ApdexAreaChart data={rows(() => ({ apdexScore: 0.9 }))} />)
		const areas = [...container.querySelectorAll(".ts-chart__area path")]
		expect(areas).toHaveLength(1)
		// `areaY` strokes the CLOSED polygon, so the band is fill-only and the top
		// edge is its own `lineY`.
		expect(areas[0]?.getAttribute("stroke")).toBe("none")
		expect(container.querySelectorAll(".ts-chart__line path")).toHaveLength(1)
	})

	it("shows the key only when the legend is asked for", () => {
		const hidden = render(<ApdexAreaChart data={rows(() => ({ apdexScore: 0.9 }))} />)
		expect(hidden.queryByText("Apdex")).toBeNull()
		hidden.unmount()

		render(<ApdexAreaChart data={rows(() => ({ apdexScore: 0.9 }))} legend="visible" />)
		expect(screen.getByText("Apdex")).toBeTruthy()
	})
})

describe("error rate area chart", () => {
	it("computes a ceiling with headroom, floored at 1% and capped at 100%", () => {
		// Recharts took this as a `domain` callback over `dataMax`; TanStack resolves
		// a domain pair up front, so the same rule is a function.
		expect(errorRateCeiling([])).toBe(0.01)
		expect(errorRateCeiling([{ errorRate: 0.001 }])).toBe(0.01)
		expect(errorRateCeiling([{ errorRate: 0.5 }])).toBeCloseTo(0.6, 10)
		expect(errorRateCeiling([{ errorRate: 0.95 }])).toBe(1)
		// Never below the data, which is what makes it a valid `softMax`.
		expect(errorRateCeiling([{ errorRate: 1 }])).toBe(1)
	})

	it("formats the axis as percentages", () => {
		const { container } = render(<ErrorRateAreaChart data={rows(() => ({ errorRate: 0.02 }))} />)
		const labels = axisTickLabels(container)
		expect(labels.some((label) => label.endsWith("%"))).toBe(true)
	})

	it("keeps a readable scale for a near-perfect window", () => {
		// Every bucket at 0.1%. Without the 1% floor the axis would zoom into the
		// noise and a healthy service would look volatile.
		const { container } = render(<ErrorRateAreaChart data={rows(() => ({ errorRate: 0.001 }))} />)
		expect(axisTickLabels(container)).toContain("1.0%")
	})

	it("dashes the in-flight tail", () => {
		const currentBucketStart = Math.floor(Date.now() / HOUR) * HOUR
		const live = Array.from({ length: 8 }, (_, index) => ({
			bucket: new Date(currentBucketStart - (7 - index) * HOUR).toISOString(),
			errorRate: 0.01 + index / 1000,
		}))
		const { container } = render(<ErrorRateAreaChart data={live} />)
		const dashed = [...container.querySelectorAll(".ts-chart__line path")].filter((path) => {
			const dash = path.getAttribute("stroke-dasharray")
			return dash != null && dash !== "" && dash !== "none"
		})
		expect(dashed).toHaveLength(1)
		expect(container.querySelectorAll(".ts-chart__area path")).toHaveLength(2)
	})
})
