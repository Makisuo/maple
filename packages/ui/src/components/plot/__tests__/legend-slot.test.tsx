import { cleanup, render } from "@testing-library/react"
import { useMemo, useState, type ReactNode } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { QueryBuilderAreaChart } from "../../charts/area/query-builder-area-chart"
import { QueryBuilderBarChart } from "../../charts/bar/query-builder-bar-chart"
import { LatencyLineChart } from "../../charts/line/latency-line-chart"
import { QueryBuilderLineChart } from "../../charts/line/query-builder-line-chart"
import { PlotLegendSlotContext, type PlotLegendItem } from "../plot-frame"

// jsdom has no ResizeObserver and lays nothing out; the charts only need the
// observer to exist and a non-zero box to draw into.
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
 * A stand-in for the dashboard card header: opens the slot and prints whatever
 * the chart publishes into it, so what a widget would show is readable as text.
 */
function LegendHost({ children }: { children: ReactNode }) {
	const [items, setItems] = useState<readonly PlotLegendItem[]>([])
	const slot = useMemo(() => ({ setItems }), [])
	return (
		<PlotLegendSlotContext value={slot}>
			<div data-testid="host-legend">
				{items.map((item) => (
					<span key={item.key} data-color={item.color}>
						{item.label}
					</span>
				))}
			</div>
			{children}
		</PlotLegendSlotContext>
	)
}

function hostLabels(container: HTMLElement): string[] {
	const host = container.querySelector("[data-testid='host-legend']")
	return [...(host?.children ?? [])].map((node) => node.textContent ?? "")
}

/** Three closed hourly buckets, three services. */
const rows = (() => {
	const hour = 3_600_000
	const start = Math.floor(Date.now() / hour) * hour - 6 * hour
	return Array.from({ length: 3 }, (_, index) => ({
		bucket: new Date(start + index * hour).toISOString(),
		api: 10 + index,
		web: 20 + index,
		worker: 30 + index,
	}))
})()

describe("the hoisted legend slot", () => {
	it("publishes the series a chart draws", () => {
		// The regression: nothing in `plot/` published, so a board tile grouped by
		// service drew three indistinguishable lines under a bare title. The card
		// header is the ONLY legend on that tile — `make-chart-widget` defaults the
		// in-plot one to hidden.
		const { container } = render(
			<LegendHost>
				<QueryBuilderAreaChart data={rows} />
			</LegendHost>,
		)
		expect(hostLabels(container)).toEqual(["api", "web", "worker"])
	})

	it("publishes a colour per series, so the swatches identify anything", () => {
		const { container } = render(
			<LegendHost>
				<QueryBuilderAreaChart data={rows} />
			</LegendHost>,
		)
		const colors = [...container.querySelectorAll("[data-testid='host-legend'] span")].map((node) =>
			node.getAttribute("data-color"),
		)
		expect(colors.every((color) => color != null && color !== "")).toBe(true)
		expect(new Set(colors).size).toBe(3)
	})

	it("stays quiet while the chart draws its own legend", () => {
		// Otherwise a tile with the in-plot legend turned on prints its series
		// twice — which is what `hoistLegend={!showLegendBlock}` prevented under
		// Recharts.
		const { container } = render(
			<LegendHost>
				<QueryBuilderAreaChart data={rows} legend="visible" />
			</LegendHost>,
		)
		expect(hostLabels(container)).toEqual([])
	})

	it("clears the slot when the chart goes away", () => {
		const { container, rerender } = render(
			<LegendHost>
				<QueryBuilderAreaChart data={rows} />
			</LegendHost>,
		)
		expect(hostLabels(container)).toHaveLength(3)
		rerender(<LegendHost>{null}</LegendHost>)
		expect(hostLabels(container)).toEqual([])
	})

	it("hoists the fixed-metric charts too, rather than only the query-builder ones", () => {
		// The overview's Latency tile. Its three percentiles are fixed, not
		// query-derived, so it never went through `useTimeseriesModel` and its
		// publish was unconditional.
		const { container } = render(
			<LegendHost>
				<LatencyLineChart />
			</LegendHost>,
		)
		expect(hostLabels(container)).toEqual(["P99", "P95", "P50"])
	})

	it("keeps a fixed-metric chart quiet while it draws its own legend", () => {
		// The duplicate this fixes: P99/P95/P50 in the card header AND again in a
		// strip under the plot.
		const { container } = render(
			<LegendHost>
				<LatencyLineChart legend="visible" />
			</LegendHost>,
		)
		expect(hostLabels(container)).toEqual([])
	})

	it("keeps the query-builder line quiet while it draws a right-hand legend", () => {
		// `legend` reached the strip but not the model, so the header published
		// anyway — the stats-table scenario printed its series in both places.
		const { container } = render(
			<LegendHost>
				<QueryBuilderLineChart data={rows} legend="right" />
			</LegendHost>,
		)
		expect(hostLabels(container)).toEqual([])
	})

	it("publishes the bar chart's recoloured series, not the hashed ones", () => {
		// The bar chart repaints its collapsed "Other" bucket neutral. The header
		// has to agree with the plot, which is why the recolour happens inside the
		// model rather than on the way to the in-plot legend.
		const { container } = render(
			<LegendHost>
				<QueryBuilderBarChart data={rows} />
			</LegendHost>,
		)
		expect(hostLabels(container)).toEqual(["api", "web", "worker"])
	})
})
