// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { usePlotLegendSlot, type PlotLegendItem } from "@maple/ui/components/plot/plot-frame"
import { useMemo } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { WidgetShell } from "@/components/dashboard-builder/widgets/widget-shell"

afterEach(cleanup)

/**
 * A stand-in for a ported chart: it publishes series into whatever legend slot
 * its host opened, which is the only thing `WidgetShell` needs from one.
 */
function PublishingChart({ series }: { series: readonly PlotLegendItem[] }) {
	const items = useMemo(() => series, [series])
	usePlotLegendSlot(items)
	return <div data-testid="chart" />
}

const threeServices: PlotLegendItem[] = [
	{ key: "s1", label: "api", color: "#ff0000" },
	{ key: "s2", label: "web", color: "#00ff00" },
	{ key: "s3", label: "worker", color: "#0000ff" },
]

describe("WidgetShell: the hoisted legend", () => {
	it("prints the series a TanStack chart publishes", () => {
		// The Recharts `ChartContainer` was the only publisher of the header strip,
		// so every ported chart's tile lost it: three lines, one title, nothing
		// saying which was which. The shell now opens both slots over one piece of
		// state.
		const { container } = render(
			<WidgetShell title="Requests" mode="view">
				<PublishingChart series={threeServices} />
			</WidgetShell>,
		)
		const header = container.querySelector("[data-slot='card-header']")
		const text = header?.textContent ?? ""
		expect(text).toContain("api")
		expect(text).toContain("web")
		expect(text).toContain("worker")
	})

	it("keeps the strip off a single-series tile", () => {
		// One chip beside the title is noise: the title already names the series.
		const { container } = render(
			<WidgetShell title="Requests" mode="view">
				<PublishingChart series={threeServices.slice(0, 1)} />
			</WidgetShell>,
		)
		expect(container.querySelector("[data-slot='card-header']")?.textContent).not.toContain("api")
	})

	it("collapses a long series list to a +N chip", () => {
		const many: PlotLegendItem[] = Array.from({ length: 8 }, (_, index) => ({
			key: `s${index}`,
			label: `svc-${index}`,
			color: "#123456",
		}))
		const { container } = render(
			<WidgetShell title="Requests" mode="view">
				<PublishingChart series={many} />
			</WidgetShell>,
		)
		expect(container.querySelector("[data-slot='card-header']")?.textContent).toContain("+3")
	})
})

describe("WidgetShell: the headline stat keeps the corner", () => {
	/**
	 * The regression restoring the legend caused. `headerValue` used to be the
	 * last thing in the header row and pushed itself right with `ml-auto`; the
	 * legend block sat after it in the DOM but never rendered, because
	 * `legendItems` was permanently empty for every ported chart. Publishing the
	 * legend made the chips real, and they landed to the RIGHT of the stat — so
	 * the number a dashboard is read by stopped being in the top-right corner.
	 */
	it("renders the headline stat after the legend chips", () => {
		const { container } = render(
			<WidgetShell title="Latency" mode="view" headerValue={<span>155.0ms</span>}>
				<PublishingChart series={threeServices} />
			</WidgetShell>,
		)

		const texts = [...container.querySelectorAll("span, div")]
			.filter((node) => node.children.length === 0)
			.map((node) => node.textContent?.trim() ?? "")

		const stat = texts.indexOf("155.0ms")
		const lastChip = texts.lastIndexOf("worker")
		expect(stat, "the headline stat renders").toBeGreaterThan(-1)
		expect(lastChip, "the legend chips render").toBeGreaterThan(-1)
		expect(stat, "the stat comes after every legend chip").toBeGreaterThan(lastChip)
	})

	/**
	 * With no chips the stat still has to reach the right edge — the push-right
	 * moved onto the legend block, so the stat can no longer rely on its own.
	 */
	it("still pushes the stat right when there is no legend", () => {
		const { container } = render(
			<WidgetShell title="Apdex" mode="view" headerValue={<span>0.98</span>}>
				<div />
			</WidgetShell>,
		)
		const stat = [...container.querySelectorAll("div")].find(
			(node) => node.textContent?.trim() === "0.98" && node.children.length === 1,
		)
		expect(stat?.className).toContain("ml-auto")
	})
})

describe("WidgetShell: dashed series in the header", () => {
	/**
	 * The Request Volume tile refused to hoist at all while it had an error
	 * series, because that series is drawn DASHED in the plot and a header chip
	 * could only paint a filled square — a solid chip would have claimed the
	 * overlay was a solid line. The tile kept its under-plot legend as a result.
	 * Carrying `dashed` through is what let it hoist like every other tile.
	 */
	it("draws a dashed outline instead of a filled swatch", () => {
		const { container } = render(
			<WidgetShell title="Request volume" mode="view">
				<PublishingChart
					series={[
						{ key: "throughput", label: "Throughput (/s)", color: "#8b5cf6" },
						{ key: "errors", label: "Errors (/s)", color: "#ef4444", dashed: true },
					]}
				/>
			</WidgetShell>,
		)

		const swatches = [...container.querySelectorAll("span")].filter((node) =>
			node.className.includes("size-2"),
		)
		expect(swatches, "one swatch per series").toHaveLength(2)

		const [solid, dashed] = swatches
		expect(solid?.className).not.toContain("border-dashed")
		expect(solid?.getAttribute("style")).toContain("background-color")

		expect(dashed?.className, "the errors chip is outlined").toContain("border-dashed")
		expect(dashed?.getAttribute("style"), "and coloured on the border").toContain("border-color")
	})
})
