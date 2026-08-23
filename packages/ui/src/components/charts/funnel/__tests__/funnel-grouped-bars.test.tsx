import { cleanup, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderFunnelChart } from "../query-builder-funnel-chart"

// jsdom has no ResizeObserver and lays nothing out; the chart only needs the
// observer to exist and a non-zero box.
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

// A breakdown: one row per group per step, groups in rank order, every group
// carrying every step — the product-event funnel route's shape with `breakdownBy`.
const grouped = [
	{ name: "/pricing", value: 80, group: "news.ycombinator.com" },
	{ name: "signup_completed", value: 40, group: "news.ycombinator.com" },
	{ name: "/pricing", value: 20, group: "twitter.com" },
	{ name: "signup_completed", value: 5, group: "twitter.com" },
]

describe("query-builder funnel: breakdown rows", () => {
	it("draws a legend with one entry per group", () => {
		const { container } = render(<QueryBuilderFunnelChart data={grouped} />)
		const legend = container.querySelector('[data-slot="funnel-legend"]')
		expect(legend?.textContent).toContain("news.ycombinator.com")
		expect(legend?.textContent).toContain("twitter.com")
	})

	it("draws one bar per group under every stage", () => {
		const { container } = render(<QueryBuilderFunnelChart data={grouped} />)
		const stageBars = container.querySelectorAll('[data-slot="funnel-group-bars"]')
		expect(stageBars).toHaveLength(2)
		for (const bars of stageBars) expect(bars.children).toHaveLength(2)
	})

	it("labels each stage with its total across groups and the share of the first stage", () => {
		const { container } = render(<QueryBuilderFunnelChart data={grouped} />)
		const text = container.textContent ?? ""
		expect(text).toContain("100")
		expect(text).toContain("45")
		expect(text).toContain("45%")
	})

	it("sizes group bars against the largest group bar anywhere in the funnel", () => {
		const { container } = render(<QueryBuilderFunnelChart data={grouped} />)
		const widths = [...container.querySelectorAll('[data-slot="funnel-group-bars"] div[style*="width"]')].map(
			(node) => (node as HTMLElement).style.width,
		)
		expect(widths).toEqual(["100%", "25%", "50%", "6.25%"])
	})

	it("keeps the unsegmented rendering when rows carry no group", () => {
		const { container } = render(
			<QueryBuilderFunnelChart data={[{ name: "a", value: 10 }, { name: "b", value: 5 }]} />,
		)
		expect(container.querySelector('[data-slot="funnel-legend"]')).toBeNull()
		expect(container.querySelectorAll('[data-slot="funnel-group-bars"]')).toHaveLength(0)
	})
})
