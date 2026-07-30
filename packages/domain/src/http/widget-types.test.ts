import { describe, expect, it } from "vitest"
import {
	defaultWidgetHeight,
	defaultWidgetLayout,
	MCP_VISUALIZATIONS,
	PANEL_TYPES,
	rawSqlDisplayTypeFor,
	widgetTypeByPersesKind,
	widgetTypeByVisualization,
} from "./widget-types"

describe("defaultWidgetHeight", () => {
	// The canvas is rowHeight 60 with a 12px gutter, so h:6 is a 420px tile.
	// Pinned because nothing else in the repo asserts these numbers, and they
	// used to be copy-pasted across six call sites that silently drifted apart.
	it("gives charts the tall default", () => {
		expect(defaultWidgetHeight("chart")).toEqual({ h: 6, minH: 2 })
	})

	it("treats every unrecognized visualization as a chart", () => {
		for (const visualization of ["gauge", "pie", "heatmap", "funnel", ""]) {
			expect(defaultWidgetHeight(visualization).h).toBe(6)
		}
	})

	it("keeps stats compact and row-based widgets at table height", () => {
		expect(defaultWidgetHeight("stat")).toEqual({ h: 2, minH: 2 })
		expect(defaultWidgetHeight("table")).toEqual({ h: 5, minH: 3 })
		expect(defaultWidgetHeight("list")).toEqual({ h: 5, minH: 3 })
		expect(defaultWidgetHeight("markdown")).toEqual({ h: 5, minH: 3 })
	})
})

describe("defaultWidgetLayout", () => {
	// The auto-place size, which is NOT the template height: a hand-added stat is
	// h:4 so it has room for a sparkline, while a template stat row is h:2.
	it("gives a hand-added stat room for a sparkline", () => {
		expect(defaultWidgetLayout("stat")).toEqual({ w: 3, h: 4, minW: 2, minH: 2 })
		expect(defaultWidgetHeight("stat").h).toBe(2)
	})

	it("gives row-based widgets the wide slot", () => {
		expect(defaultWidgetLayout("table")).toEqual({ w: 6, h: 5, minW: 3, minH: 3 })
		expect(defaultWidgetLayout("list")).toEqual({ w: 6, h: 5, minW: 3, minH: 3 })
	})

	it("falls back to the chart slot for anything unknown", () => {
		expect(defaultWidgetLayout("chart")).toEqual({ w: 4, h: 6, minW: 2, minH: 2 })
		expect(defaultWidgetLayout("not-a-widget")).toEqual({ w: 4, h: 6, minW: 2, minH: 2 })
	})

	it("returns a fresh object so callers can spread and mutate", () => {
		expect(defaultWidgetLayout("stat")).not.toBe(defaultWidgetLayout("stat"))
	})
})

describe("owned display keys", () => {
	// `buildWidgetDisplay` clears the union of these before each type writes back
	// the keys it owns, so a key dropped from every type's list stops being
	// cleared and starts leaking across a type switch — which is how a line chart
	// switched to Pie kept `chartId: "query-builder-line"` and rendered a line
	// over breakdown rows. Pinned so the union can only change deliberately.
	//
	// Keys absent here (`pie`, `funnel`, `histogram`, `xAxis`, …) are never
	// written by the builder and are preserved across a switch on purpose.
	it("clears exactly the keys the builder writes", () => {
		const union = new Set(PANEL_TYPES.flatMap((meta) => meta.ownedDisplayKeys))
		expect([...union].sort()).toEqual([
			"chartId",
			"columns",
			"curveType",
			"gauge",
			"heatmap",
			"listDataSource",
			"listLimit",
			"listRootOnly",
			"listWhereClause",
			"markdown",
			"sparkline",
			"stacked",
			"thresholds",
		])
	})

	it("gives every chart-mounting panel type ownership of chartId", () => {
		for (const meta of PANEL_TYPES) {
			expect(meta.ownedDisplayKeys.includes("chartId"), meta.panelType).toBe(meta.chartId != null)
		}
	})

	it("keeps a canonical chartId and category in step", () => {
		for (const meta of PANEL_TYPES) {
			expect(meta.chartId == null, meta.panelType).toBe(meta.chartCategory == null)
			if (meta.chartId) expect(meta.chartId).toBe(`query-builder-${meta.chartCategory}`)
		}
	})
})

describe("widgetTypeByVisualization", () => {
	it("resolves an ambiguous chart to line", () => {
		expect(widgetTypeByVisualization("chart")?.panelType).toBe("line")
	})

	it("returns undefined for an unknown visualization", () => {
		expect(widgetTypeByVisualization("sankey")).toBeUndefined()
	})
})

describe("rawSqlDisplayTypeFor", () => {
	it("disambiguates the three chart panel types by chartId", () => {
		expect(rawSqlDisplayTypeFor("chart", "query-builder-bar")).toBe("bar")
		expect(rawSqlDisplayTypeFor("chart", "gradient-area")).toBe("area")
		expect(rawSqlDisplayTypeFor("chart", undefined)).toBe("line")
	})

	// There is no `gauge` member of RawSqlDisplayType — a gauge is a scalar on an
	// arc, the same single-row SQL shape as a stat.
	it("renders a gauge as a stat", () => {
		expect(rawSqlDisplayTypeFor("gauge")).toBe("stat")
	})

	it("falls back to line for types with no SQL rendering", () => {
		expect(rawSqlDisplayTypeFor("markdown")).toBe("line")
	})
})

describe("widgetTypeByPersesKind", () => {
	it("maps the kinds the importer has always handled", () => {
		expect(widgetTypeByPersesKind("StatChart").panelType).toBe("stat")
		expect(widgetTypeByPersesKind("GaugeChart").panelType).toBe("gauge")
		expect(widgetTypeByPersesKind("BarChart").visualization).toBe("chart")
		expect(widgetTypeByPersesKind("BarChart").rawSqlDisplayType).toBe("bar")
		expect(widgetTypeByPersesKind("LogsTable").panelType).toBe("table")
		expect(widgetTypeByPersesKind("Heatmap").panelType).toBe("heatmap")
	})

	it("falls back to a line chart", () => {
		expect(widgetTypeByPersesKind(undefined).panelType).toBe("line")
		expect(widgetTypeByPersesKind("SomeFuturePlugin").panelType).toBe("line")
	})
})

describe("MCP_VISUALIZATIONS", () => {
	it("collapses line/bar/area into one chart entry", () => {
		expect(MCP_VISUALIZATIONS.filter((viz) => viz === "chart")).toHaveLength(1)
	})

	it("exposes every widget kind an agent can build", () => {
		expect([...MCP_VISUALIZATIONS].sort()).toEqual([
			"chart",
			"funnel",
			"gauge",
			"heatmap",
			"histogram",
			"list",
			"markdown",
			"pie",
			"stat",
			"table",
		])
	})
})
