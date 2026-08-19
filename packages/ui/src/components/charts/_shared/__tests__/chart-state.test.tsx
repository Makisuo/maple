/**
 * The point of `ChartPlotArea` is that a chart's loading, empty and error
 * branches cannot reserve a different box than the plot they stand in for.
 * Before it, each branch carried its own `h-[280px]` literal and they drifted.
 * These pin the sizing contract that replaced those literals.
 */
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { ChartEmpty, ChartError, ChartLoading, ChartPlotArea, useChartPlotHeight } from "../chart-state"

afterEach(cleanup)

function HeightProbe() {
	return <span data-testid="probe">{String(useChartPlotHeight())}</span>
}

describe("ChartPlotArea", () => {
	it("reserves the declared height and publishes it to descendants", () => {
		const { getByTestId, container } = render(
			<ChartPlotArea height={280}>
				<HeightProbe />
			</ChartPlotArea>,
		)

		const area = container.querySelector("[data-slot='chart-plot-area']")
		expect(area).toHaveProperty("style.height", "280px")
		expect(getByTestId("probe").textContent).toBe("280")
	})

	it("reports no height outside a provider, so a chart can fall back", () => {
		const { getByTestId } = render(<HeightProbe />)
		expect(getByTestId("probe").textContent).toBe("null")
	})
})

describe("chart states inside a plot area", () => {
	// Every branch fills the SAME reserved box. `100%` rather than a repeated
	// pixel value is what makes that true by construction: the number exists in
	// one place, on the provider.
	it.each([
		["loading", <ChartLoading key="l" variant="area" />],
		["empty", <ChartEmpty key="e">No data</ChartEmpty>],
		["error", <ChartError key="r">Boom</ChartError>],
	])("%s fills the reserved box rather than restating its height", (_name, node) => {
		const { container } = render(<ChartPlotArea height={280}>{node}</ChartPlotArea>)

		const box = container.querySelector("[data-slot='chart-plot-area'] > div")
		expect(box).toHaveProperty("style.height", "100%")
	})

	it("lets an explicit height override the inherited one", () => {
		const { container } = render(
			<ChartPlotArea height={280}>
				<ChartEmpty height={120}>No data</ChartEmpty>
			</ChartPlotArea>,
		)

		const box = container.querySelector("[data-slot='chart-plot-area'] > div")
		expect(box).toHaveProperty("style.height", "120px")
	})
})

describe("empty vs error", () => {
	// These are separate components rather than one with a `tone` flag precisely
	// so they cannot converge. If someone collapses them, this fails.
	it("renders an ordinary outcome as muted and a failure as destructive", () => {
		const { container: empty } = render(<ChartEmpty height={200}>No data</ChartEmpty>)
		const { container: failed } = render(<ChartError height={200}>Boom</ChartError>)

		const emptyClasses = empty.firstElementChild?.className ?? ""
		const errorClasses = failed.firstElementChild?.className ?? ""

		expect(emptyClasses).toContain("text-muted-foreground")
		expect(emptyClasses).not.toContain("destructive")
		expect(errorClasses).toContain("text-destructive")

		// Shared typography — the half that IS supposed to match.
		expect(emptyClasses).toContain("font-mono")
		expect(errorClasses).toContain("font-mono")
	})

	it("draws no border around an empty window, matching ChartCardMessage", () => {
		const { container } = render(<ChartEmpty height={200}>No data</ChartEmpty>)
		expect(container.firstElementChild?.className ?? "").not.toContain("border-dashed")
	})
})
