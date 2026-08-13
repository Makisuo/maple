// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { WidgetDataState, WidgetDisplayConfig } from "@/components/dashboard-builder/types"

// The live path is what we are asserting *about*, so it is mocked rather than
// exercised — this file is about which path runs, not about fetching.
const useWidgetDataSource = vi.hoisted(() => vi.fn(() => ({ dataState: { status: "loading" } })))
vi.mock("@/hooks/use-widget-data", () => ({ useWidgetDataSource }))

// The sparkline is an SVG chart that measures itself; stand in for it so the
// assertions can read the series it was handed rather than rendered pixels.
const sparklineSpy = vi.hoisted(() => vi.fn())
vi.mock("@maple/ui/components/charts/sparkline/stat-sparkline", () => ({
	StatSparkline: (props: { data: unknown[] }) => {
		sparklineSpy(props.data)
		return <div data-testid="sparkline" data-rows={props.data.length} />
	},
}))

const { SparklineSeriesScope, StatWidget } = await import("./stat-widget")

beforeAll(() => {
	class noop {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	vi.stubGlobal("ResizeObserver", noop)
})

afterEach(() => {
	cleanup()
	useWidgetDataSource.mockClear()
	sparklineSpy.mockClear()
})

const ready = (data: unknown): WidgetDataState => ({ status: "ready", data })

/** A stat with a sparkline configured — the only shape that reaches the seam. */
const displayWithSparkline: WidgetDisplayConfig = {
	title: "Requests",
	sparkline: {
		enabled: true,
		dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
	},
}

const rows = [{ ts: "2026-01-01T00:00:00Z", value: 1 }]

describe("StatWidget sparkline seam", () => {
	it("fetches when no scope is mounted — the production path", () => {
		render(<StatWidget dataState={ready(42)} display={displayWithSparkline} mode="view" />)

		expect(useWidgetDataSource).toHaveBeenCalledOnce()
	})

	it("renders the supplied series under a scope, without fetching", () => {
		render(
			<SparklineSeriesScope resolve={() => ready(rows)}>
				<StatWidget dataState={ready(42)} display={displayWithSparkline} mode="view" />
			</SparklineSeriesScope>,
		)

		expect(useWidgetDataSource).not.toHaveBeenCalled()
		expect(sparklineSpy).toHaveBeenCalledWith(rows)
	})

	it("renders an empty sparkline when the scope resolves to an error — never fabricated data", () => {
		// The guard on the fixture policy. A resolver that cannot answer must
		// produce the same empty trend a real failed query does; if the widget
		// ever substituted its own sample rows here, a broken query would render
		// as a plausible-looking chart.
		render(
			<SparklineSeriesScope resolve={() => ({ status: "error", kind: "runtime" })}>
				<StatWidget dataState={ready(42)} display={displayWithSparkline} mode="view" />
			</SparklineSeriesScope>,
		)

		expect(sparklineSpy).toHaveBeenCalledWith([])
		expect(screen.getByTestId("sparkline").dataset.rows).toBe("0")
	})

	it("does not reach the seam at all when no sparkline is configured", () => {
		render(<StatWidget dataState={ready(42)} display={{ title: "Requests" }} mode="view" />)

		expect(useWidgetDataSource).not.toHaveBeenCalled()
		expect(screen.queryByTestId("sparkline")).toBeNull()
	})
})
