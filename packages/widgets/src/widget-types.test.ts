import { describe, expect, it } from "vitest"
import {
	defaultWidgetLayout,
	isMcpVisualization,
	isWidgetVisualization,
	MCP_VISUALIZATIONS,
	PANEL_TYPES,
	rawSqlDisplayTypeFor,
	widgetTypeByPersesKind,
	widgetTypeByVisualization,
	WIDGET_VISUALIZATIONS,
} from "./widget-types"

describe("defaultWidgetLayout", () => {
	// The one auto-place size. There used to be a second, `templateHeight`, which
	// packed stat rows to h:2 — but templates hand-write every layout literal and
	// never called it, so it was removed rather than left half-connected.
	it("gives a hand-added stat room for a sparkline", () => {
		expect(defaultWidgetLayout("stat")).toEqual({ w: 3, h: 4, minW: 2, minH: 2 })
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

	// Pinned: both are configured by their own panel, never by SQL, and the MCP
	// tools have always rendered them as `line`. Giving `list` a `"table"` display
	// type reads as an obvious improvement and is a silent behavior change.
	it("falls back to line for types with no SQL rendering", () => {
		expect(rawSqlDisplayTypeFor("markdown")).toBe("line")
		expect(rawSqlDisplayTypeFor("list")).toBe("line")
	})

	it("falls back to line for a visualization it doesn't know", () => {
		expect(rawSqlDisplayTypeFor("sankey")).toBe("line")
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
			"hbar",
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

// `WIDGET_VISUALIZATIONS` is the const tuple schema v2 closes the stored
// `visualization` field against. `WIDGET_TYPES` is typed against it, so the
// compiler already stops the table naming a member that isn't here; this covers
// the direction the compiler can't — a member left behind after the panel type
// that claimed it was removed, which would keep a dead kind decodable forever.
describe("WIDGET_VISUALIZATIONS", () => {
	it("is exactly the set the widget type table claims", () => {
		expect([...WIDGET_VISUALIZATIONS].sort()).toEqual(
			[...new Set(PANEL_TYPES.map((meta) => meta.visualization))].sort(),
		)
	})

	it("narrows only its own members", () => {
		for (const visualization of WIDGET_VISUALIZATIONS) {
			expect(isWidgetVisualization(visualization)).toBe(true)
		}
		for (const notAVisualization of ["sankey", "Chart", "", "line", undefined, null, 7]) {
			expect(isWidgetVisualization(notAVisualization)).toBe(false)
		}
	})

	// `line` is a PanelType, not a visualization — it persists as `chart`. The
	// guard must not accept it, or a widget could be stored under a kind the
	// renderer registry has no entry for.
	it("rejects panel types that are not themselves a visualization", () => {
		expect(isWidgetVisualization("line")).toBe(false)
		expect(isWidgetVisualization("bar")).toBe(false)
		expect(isWidgetVisualization("area")).toBe(false)
	})

	it("scopes the MCP subset to the same set", () => {
		for (const visualization of MCP_VISUALIZATIONS) {
			expect(isWidgetVisualization(visualization)).toBe(true)
			expect(isMcpVisualization(visualization)).toBe(true)
		}
		expect(isMcpVisualization("sankey")).toBe(false)
	})
})
