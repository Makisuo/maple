import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderLineChart } from "../query-builder-line-chart"

// Same harness as `partial-tail.test.tsx`: jsdom has no ResizeObserver and lays
// nothing out, and with no Canvas 2D context `PlotFrame` degrades to the SVG
// renderer — which is what makes the marks inspectable as real nodes.
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

const ROWS = [
	{ bucket: "2026-01-01T00:00:00Z", latency: 120 },
	{ bucket: "2026-01-01T01:00:00Z", latency: 340 },
	{ bucket: "2026-01-01T02:00:00Z", latency: 260 },
]

const textContents = (container: HTMLElement): string[] =>
	[...container.querySelectorAll("text")].map((node) => node.textContent?.trim() ?? "")

describe("query-builder line: threshold labels", () => {
	/**
	 * This asserts the WIRING, not the mark. `thresholdRules` can render a label
	 * perfectly well and still produce none, because the label is omitted unless
	 * the caller supplies `labelX` — and for a while every caller omitted it while
	 * the helper's own comment described supplying it as "the caller's job". The
	 * rule kept drawing, so nothing looked broken; the widget just lost the only
	 * thing distinguishing its SLO line from any other dashed rule.
	 */
	it("draws the threshold's label", () => {
		const { container } = render(
			<QueryBuilderLineChart
				data={ROWS}
				thresholds={[{ value: 300, color: "#ef4444", label: "SLO" }]}
			/>,
		)
		expect(textContents(container)).toContain("SLO")
	})

	it("draws one label per named threshold", () => {
		const { container } = render(
			<QueryBuilderLineChart
				data={ROWS}
				thresholds={[
					{ value: 300, color: "#ef4444", label: "SLO" },
					{ value: 150, color: "#f59e0b", label: "Warn" },
				]}
			/>,
		)
		const texts = textContents(container)
		expect(texts).toContain("SLO")
		expect(texts).toContain("Warn")
	})

	/**
	 * An unnamed threshold is a bare rule. It must not paint an empty text node,
	 * which would be an invisible focus-free artefact in the scene.
	 */
	it("draws no label when the threshold has none", () => {
		const { container } = render(
			<QueryBuilderLineChart data={ROWS} thresholds={[{ value: 300, color: "#ef4444" }]} />,
		)
		expect(textContents(container)).not.toContain("")
	})

	/**
	 * With no rows there is no last bucket, so `labelX` is `undefined` and the
	 * labels are omitted rather than anchored at a guessed position. The chart
	 * must still render instead of throwing on `rows.at(-1)`.
	 */
	it("survives an empty result with a labelled threshold", () => {
		const { container } = render(
			<QueryBuilderLineChart data={[]} thresholds={[{ value: 300, color: "#ef4444", label: "SLO" }]} />,
		)
		expect(textContents(container)).not.toContain("SLO")
	})
})
