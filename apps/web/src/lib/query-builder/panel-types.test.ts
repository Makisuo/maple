import { describe, expect, it } from "vitest"
import {
	PANEL_TYPES,
	canonicalChartId,
	fromPanelType,
	toPanelType,
	type PanelType,
} from "@/lib/query-builder/panel-types"

const ALL_PANELS = PANEL_TYPES.map((panel) => panel.value)

describe("panel type round-trip", () => {
	it("survives a full round-trip for every panel type", () => {
		for (const panel of ALL_PANELS) {
			const { visualization, chartId } = fromPanelType(panel)
			expect(toPanelType(visualization, chartId), panel).toBe(panel)
		}
	})

	it("maps line/bar/area onto the chart visualization", () => {
		expect(fromPanelType("line")).toEqual({
			visualization: "chart",
			chartId: "query-builder-line",
		})
		expect(fromPanelType("bar")).toEqual({ visualization: "chart", chartId: "query-builder-bar" })
		expect(fromPanelType("area")).toEqual({ visualization: "chart", chartId: "query-builder-area" })
	})

	it("gives breakdown visualizations their own kind plus a canonical chartId", () => {
		expect(fromPanelType("pie")).toEqual({ visualization: "pie", chartId: "query-builder-pie" })
		expect(fromPanelType("funnel")).toEqual({
			visualization: "funnel",
			chartId: "query-builder-funnel",
		})
	})

	it("leaves chartId unset for visualizations that don't mount a chart component", () => {
		for (const panel of ["stat", "gauge", "table", "list", "markdown"] as PanelType[]) {
			expect(fromPanelType(panel).chartId, panel).toBeUndefined()
			expect(canonicalChartId(panel), panel).toBeUndefined()
		}
	})
})

describe("toPanelType", () => {
	it("reports the real panel type of a widget corrupted by the old Chart Style dropdown", () => {
		// `visualization: "chart"` + a pie chartId is what the old dropdown wrote.
		// Surfacing it as `pie` is what lets toInitialState repair the widget.
		expect(toPanelType("chart", "query-builder-pie")).toBe("pie")
		expect(toPanelType("chart", "query-builder-histogram")).toBe("histogram")
		expect(toPanelType("chart", "query-builder-heatmap")).toBe("heatmap")
		expect(toPanelType("chart", "query-builder-funnel")).toBe("funnel")
	})

	it("defaults a chart with no chartId to line", () => {
		expect(toPanelType("chart", undefined)).toBe("line")
	})

	it("defaults an unknown chartId to line rather than throwing", () => {
		expect(toPanelType("chart", "does-not-exist")).toBe("line")
	})

	it("derives the panel type from a non-canonical chart style's category", () => {
		expect(toPanelType("chart", "latency-line")).toBe("line")
		expect(toPanelType("chart", "gradient-area")).toBe("area")
		expect(toPanelType("chart", "default-bar")).toBe("bar")
	})

	it("falls back to line for an unrecognized visualization", () => {
		expect(toPanelType("something-new")).toBe("line")
	})
})

describe("fromPanelType chartId preservation", () => {
	it("keeps a non-canonical style when its category already matches the panel", () => {
		// Re-selecting the type a widget already has must not rewrite its style —
		// that would both destroy the style and make a no-op click read as dirty.
		expect(fromPanelType("line", "latency-line").chartId).toBe("latency-line")
		expect(fromPanelType("area", "gradient-area").chartId).toBe("gradient-area")
	})

	it("replaces a chartId that belongs to a different panel", () => {
		expect(fromPanelType("pie", "query-builder-line").chartId).toBe("query-builder-pie")
		expect(fromPanelType("line", "query-builder-pie").chartId).toBe("query-builder-line")
	})
})
