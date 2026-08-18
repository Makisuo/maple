import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderFunnelChart } from "../query-builder-funnel-chart"

// jsdom has no ResizeObserver and lays nothing out; the chart only needs the
// observer to exist and a non-zero box, which is what decides how many stages
// fit before the "+N more" footer takes over.
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

/** Every stage's bar fill, as a percentage-of-the-largest-stage width. */
function barWidths(container: HTMLElement): string[] {
	return [...container.querySelectorAll("div[style*='width']")].map(
		(node) => (node as HTMLElement).style.width,
	)
}

const stages = [
	{ name: "Visited", value: 100 },
	{ name: "Signed up", value: 40 },
	{ name: "Purchased", value: 20 },
]

/**
 * `showStepPercent` gates BOTH percentage labels, which is three states out of
 * one optional boolean and the reason each one is pinned separately: setting it
 * `false` used to leave the "share of the first stage" label on screen, so a
 * widget that explicitly asked for no percentages still got them.
 */
describe("query-builder funnel: the three percentage states", () => {
	it("unset shows the share of the first stage and no step conversion", () => {
		const { container } = render(<QueryBuilderFunnelChart data={stages} />)
		const text = container.textContent ?? ""
		expect(text).toContain("100%")
		expect(text).toContain("40%")
		expect(text).toContain("20%")
		// 20 of the preceding 40 — the step conversion, which is off here.
		expect(text).not.toContain("50%")
	})

	it("true adds the step-to-step conversion alongside it", () => {
		const { container } = render(<QueryBuilderFunnelChart data={stages} showStepPercent />)
		const text = container.textContent ?? ""
		expect(text).toContain("20%")
		expect(text).toContain("50%")
	})

	it("false suppresses both", () => {
		const { container } = render(<QueryBuilderFunnelChart data={stages} showStepPercent={false} />)
		const text = container.textContent ?? ""
		expect(text).not.toContain("%")
		// The values themselves are not percentages and stay.
		expect(text).toContain("100")
		expect(text).toContain("40")
	})
})

describe("query-builder funnel: stage bars", () => {
	it("scales each bar against the largest stage", () => {
		const { container } = render(<QueryBuilderFunnelChart data={stages} />)
		expect(barWidths(container)).toEqual(["100%", "40%", "20%"])
	})

	it("keeps one drop-to-zero stage and drops the empty tail behind it", () => {
		// A funnel that genuinely falls to zero reads differently from a pile of
		// empty groups at the end, so exactly one zero stage survives.
		const { container } = render(
			<QueryBuilderFunnelChart
				data={[...stages, { name: "Refunded", value: 0 }, { name: "Ghost", value: 0 }]}
			/>,
		)
		const text = container.textContent ?? ""
		expect(text).toContain("Refunded")
		expect(text).not.toContain("Ghost")
	})

	it("aggregates mis-fed timeseries rows into one stage per series", () => {
		// A mis-wired widget can hand a categorical chart `{bucket, seriesA, …}`
		// rows; one "—" stage per time bucket would be meaningless.
		const { container } = render(
			<QueryBuilderFunnelChart
				data={[
					{ bucket: "2026-01-01T00:00:00Z", "api-v2": 12, "config-api": 3 },
					{ bucket: "2026-01-01T00:05:00Z", "api-v2": 15, "config-api": 4 },
				]}
			/>,
		)
		const text = container.textContent ?? ""
		expect(text).toContain("api-v2")
		expect(text).toContain("27")
		expect(text).not.toContain("bucket")
	})
})
