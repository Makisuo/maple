// TEST-SEAM: `ResponsiveContainer` measures the DOM, which jsdom cannot; it is
// replaced with a fixed-size box so Recharts lays the chart out and the SVG can
// be inspected.
/**
 * A live chart never invents data.
 *
 * Every query-builder chart used to substitute sample rows whenever `data` was
 * not a non-empty array. That turned every mis-fed tile — a share page handing
 * over `{ data: rows }` where `rows` belongs, an empty result — into a
 * plausible-looking picture with series called "A" and "B". The histogram
 * dropped its fallback first; this pins that none of the others has one either:
 * with no data there are no series, and with data the chart draws it.
 */
import { cleanup, render } from "@testing-library/react"
import * as React from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

// jsdom has no ResizeObserver and lays nothing out; the container-size hook
// only needs the observer to exist and a non-zero box to draw into.
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

vi.mock("recharts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("recharts")>()
	const ResponsiveContainer = ({ children }: { children: React.ReactNode }) => (
		<div style={{ width: 800, height: 400 }}>
			{React.isValidElement(children)
				? React.cloneElement(children as React.ReactElement<{ width?: number; height?: number }>, {
						width: 800,
						height: 400,
					})
				: children}
		</div>
	)
	return { ...actual, ResponsiveContainer }
})

import type { BaseChartProps } from "./_shared/chart-types"
import { QueryBuilderAreaChart } from "./area/query-builder-area-chart"
import { QueryBuilderBarChart } from "./bar/query-builder-bar-chart"
import { QueryBuilderFunnelChart } from "./funnel/query-builder-funnel-chart"
import { QueryBuilderHbarChart } from "./hbar/query-builder-hbar-chart"
import { QueryBuilderHeatmapChart } from "./heatmap/query-builder-heatmap-chart"
import { QueryBuilderLineChart } from "./line/query-builder-line-chart"
import { QueryBuilderPieChart } from "./pie/query-builder-pie-chart"

const timeseriesRows = [
	{ bucket: "2026-01-01T00:00:00Z", "api-v2": 12, "config-api": 3 },
	{ bucket: "2026-01-01T00:05:00Z", "api-v2": 15, "config-api": 4 },
	{ bucket: "2026-01-01T00:10:00Z", "api-v2": 9, "config-api": 5 },
]
const breakdownRows = [
	{ name: "GET /a", value: 9 },
	{ name: "GET /b", value: 4 },
]

/** Names that only the old sample fixtures carried. */
const SAMPLE_MARKERS = ["A", "B", "Checkout", "Search", "Cart", "Home", "Landing", "Signup"]

const textOf = (container: HTMLElement): string => container.textContent ?? ""

/**
 * Every text node on its own. `textContent` glues adjacent spans together
 * ("A" + "B" → "AB"), which is how a whole-word check on it misses a legend
 * made of exactly the sample series names.
 */
const textNodesOf = (container: HTMLElement): ReadonlyArray<string> => {
	const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT)
	const nodes: string[] = []
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
		const text = node.textContent?.trim() ?? ""
		if (text.length > 0) nodes.push(text)
	}
	return nodes
}

/**
 * The wrong shapes a live tile can be handed — the share envelope, a scalar,
 * an empty result. Typed as `data` deliberately: the whole point is what the
 * chart does when its prop is not what the type promises.
 */
// SAFETY: test fixtures for mis-fed inputs; the chart's runtime guard, not its
// prop type, is under test.
const misfed = (value: unknown): BaseChartProps["data"] => value as BaseChartProps["data"]

const cases: ReadonlyArray<{
	name: string
	Chart: React.ComponentType<BaseChartProps>
	rows: Array<Record<string, unknown>>
	/** Text the chart shows for `rows` and must not show for no data. */
	marker: string
	legend?: "visible" | "hidden" | "right"
}> = [
	{ name: "line", Chart: QueryBuilderLineChart, rows: timeseriesRows, marker: "api-v2" },
	{ name: "area", Chart: QueryBuilderAreaChart, rows: timeseriesRows, marker: "api-v2" },
	{ name: "bar", Chart: QueryBuilderBarChart, rows: timeseriesRows, marker: "api-v2" },
	{ name: "pie", Chart: QueryBuilderPieChart, rows: breakdownRows, marker: "GET /a", legend: "right" },
	{ name: "funnel", Chart: QueryBuilderFunnelChart, rows: breakdownRows, marker: "GET /a" },
	{ name: "hbar", Chart: QueryBuilderHbarChart, rows: breakdownRows, marker: "GET /a" },
]

describe("query-builder charts never fall back to sample data", () => {
	afterEach(cleanup)

	for (const { name, Chart, rows, marker, legend = "visible" } of cases) {
		it(`${name}: draws the rows it is given and nothing when it is given none`, () => {
			const withData = render(<Chart data={rows} legend={legend} />)
			expect(textOf(withData.container)).toContain(marker)
			withData.unmount()

			for (const empty of [undefined, {}, { data: rows }, []]) {
				const withoutData = render(<Chart data={misfed(empty)} legend={legend} />)
				expect(textOf(withoutData.container)).not.toContain(marker)
				const nodes = textNodesOf(withoutData.container)
				for (const sample of SAMPLE_MARKERS) {
					// Whole-node: "A" must not match "Area" or a CSS class.
					expect(nodes).not.toContain(sample)
				}
				withoutData.unmount()
			}
		})
	}

	it("heatmap: no data means no cells", () => {
		const withData = render(
			<QueryBuilderHeatmapChart
				data={[
					{ x: "api-v2", y: "GET", value: 3 },
					{ x: "config-api", y: "POST", value: 5 },
				]}
			/>,
		)
		expect(textOf(withData.container)).toContain("api-v2")
		withData.unmount()

		const withoutData = render(<QueryBuilderHeatmapChart data={undefined} />)
		expect(textOf(withoutData.container)).not.toContain("api-v2")
		const nodes = textNodesOf(withoutData.container)
		for (const sample of SAMPLE_MARKERS) {
			expect(nodes).not.toContain(sample)
		}
	})
})
