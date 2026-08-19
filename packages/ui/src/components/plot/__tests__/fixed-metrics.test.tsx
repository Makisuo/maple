import { cleanup, render, screen } from "@testing-library/react"
import { useEffect } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { ChartTooltipSuppressionProvider, useSuppressChartTooltip } from "../floating-tooltip"
import { normaliseFixedRows, useFixedMetricModel } from "../fixed-metrics"
import { cursorTooltip, maybeTooltip } from "../plot-tooltip"

afterEach(cleanup)

describe("normaliseFixedRows", () => {
	it("parses the bucket and keeps every other column", () => {
		const [row] = normaliseFixedRows([
			{ bucket: "2024-01-01T00:00:00Z", throughput: 12, hasSampling: true },
		])
		expect(row?.date.toISOString()).toBe("2024-01-01T00:00:00.000Z")
		// A fixed-metric chart derives series from SIBLING columns and reads flags
		// off the row, so dropping the columns it did not name would break the
		// derivation — this is the difference from `normaliseTimeseriesRows`.
		expect(row?.throughput).toBe(12)
		expect(row?.hasSampling).toBe(true)
	})

	it("drops rows with no parseable bucket", () => {
		expect(
			normaliseFixedRows([
				{ bucket: "2024-01-01T00:00:00Z" },
				{ bucket: "nonsense" },
				{ throughput: 1 },
			]),
		).toHaveLength(1)
	})

	it("returns nothing for a non-array, rather than guessing", () => {
		// A share page handing over an envelope where an array belongs used to draw
		// plausible-looking sample data.
		expect(normaliseFixedRows(undefined)).toEqual([])
	})
})

describe("maybeTooltip", () => {
	it("omits the tooltip entirely while suppressed", () => {
		// Returning `null` from `renderTooltipBody` would still paint the shell — an
		// empty card following the cursor. Omitting `tooltip:` is the only actual
		// suppression, which is why this returns `undefined` rather than a disabled
		// spec.
		expect(maybeTooltip(true, "pointer")).toBeUndefined()
		expect(maybeTooltip(false, "pointer")).toEqual(cursorTooltip("pointer"))
	})
})

/** Reads the model and prints the one field a test can observe from outside. */
function SuppressionProbe() {
	const model = useFixedMetricModel([{ bucket: "2024-01-01T00:00:00Z", value: 1 }])
	return <span data-testid="suppressed">{String(model.suppressed)}</span>
}

/**
 * Stands in for the commit-markers overlay: raises suppression on mount, the
 * same way `CommitMarkersOverlay` does when a marker card opens.
 */
function Suppressor() {
	const setSuppressed = useSuppressChartTooltip()
	useEffect(() => setSuppressed(true), [setSuppressed])
	return null
}

describe("useFixedMetricModel: tooltip suppression", () => {
	it("is false with no provider above it", () => {
		// Without a `ChartTooltipSuppressionProvider` the suppression calls are
		// no-ops — a chart outside a grid keeps its tooltip.
		render(<SuppressionProbe />)
		expect(screen.getByTestId("suppressed").textContent).toBe("false")
	})

	it("follows an overlay's suppression through the provider", () => {
		render(
			<ChartTooltipSuppressionProvider>
				<Suppressor />
				<SuppressionProbe />
			</ChartTooltipSuppressionProvider>,
		)
		// The provider is what lets a marker card on ANY chart quiet the tooltips on
		// its siblings, which is why the flag travels through context rather than
		// living in the chart.
		expect(screen.getByTestId("suppressed").textContent).toBe("true")
	})
})
