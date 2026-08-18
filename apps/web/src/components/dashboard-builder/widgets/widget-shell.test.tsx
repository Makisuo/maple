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
