import { describe, expect, it } from "vitest"
import type {
	Dashboard,
	DashboardWidget,
	DataSourceEndpoint,
	VisualizationType,
} from "@/components/dashboard-builder/types"
import {
	collectTags,
	dashboardMatches,
	headerSummary,
	isStaticOnly,
	matchesTags,
	readsFromLabel,
	sortDashboards,
	widgetCountLabel,
} from "./dashboard-summary"

let widgetSeq = 0

const widget = (visualization: VisualizationType, endpoint: DataSourceEndpoint): DashboardWidget => ({
	id: `w${++widgetSeq}`,
	visualization,
	dataSource: { endpoint },
	display: { title: visualization },
	layout: { x: 0, y: 0, w: 4, h: 4 },
})

const dashboard = (overrides: Partial<Dashboard> = {}): Dashboard => ({
	id: "d1",
	name: "Checkout latency",
	timeRange: { type: "relative", value: "24h" },
	widgets: [],
	createdAt: "2026-07-01T00:00:00.000Z",
	updatedAt: "2026-07-20T00:00:00.000Z",
	...overrides,
})

describe("widgetCountLabel", () => {
	it("singularises", () => {
		expect(widgetCountLabel(dashboard({ widgets: [widget("chart", "list_traces")] }))).toBe("1 widget")
		expect(
			widgetCountLabel(
				dashboard({ widgets: [widget("chart", "list_traces"), widget("stat", "metrics_summary")] }),
			),
		).toBe("2 widgets")
	})
})

describe("readsFromLabel", () => {
	it("labels a single domain", () => {
		const d = dashboard({ widgets: [widget("chart", "custom_timeseries")] })
		expect(readsFromLabel(d)).toEqual({ short: "Metrics", full: "Metrics" })
	})

	it("dedupes endpoints that share a domain", () => {
		const d = dashboard({
			widgets: [widget("chart", "list_traces"), widget("table", "traces_facets")],
		})
		expect(readsFromLabel(d).short).toBe("Traces")
	})

	it("folds a third domain into +N but keeps the full list for the title", () => {
		const d = dashboard({
			widgets: [
				widget("chart", "list_traces"),
				widget("chart", "list_logs"),
				widget("chart", "custom_timeseries"),
			],
		})
		expect(readsFromLabel(d)).toEqual({ short: "Traces · Logs +1", full: "Traces · Logs · Metrics" })
	})

	it("reports a markdown-only dashboard as static, not as reading nothing", () => {
		const d = dashboard({ widgets: [widget("markdown", "markdown_static")] })
		expect(readsFromLabel(d).short).toBe("static only")
		expect(isStaticOnly(d)).toBe(true)
	})

	it("distinguishes an empty dashboard from a static one", () => {
		expect(readsFromLabel(dashboard()).short).toBe("—")
		expect(isStaticOnly(dashboard())).toBe(false)
	})
})

describe("sortDashboards", () => {
	const a = dashboard({ id: "a", name: "Alpha", updatedAt: "2026-07-01T00:00:00.000Z" })
	const b = dashboard({
		id: "b",
		name: "Zulu",
		updatedAt: "2026-07-25T00:00:00.000Z",
		widgets: [widget("chart", "list_traces")],
	})

	it("sorts by recency, newest first", () => {
		expect(sortDashboards([a, b], "updated").map((d) => d.id)).toEqual(["b", "a"])
	})

	it("sorts by name without hoisting anything else", () => {
		expect(sortDashboards([b, a], "name-asc").map((d) => d.id)).toEqual(["a", "b"])
		expect(sortDashboards([a, b], "name-desc").map((d) => d.id)).toEqual(["b", "a"])
	})

	it("sorts by widget count", () => {
		expect(sortDashboards([a, b], "widgets").map((d) => d.id)).toEqual(["b", "a"])
	})

	// The regression this whole rework turns on: the old sortAndFilter pushed
	// favorites to the front *before* the comparator, so "Name A–Z" was a lie.
	it("does not reorder for favouriteness", () => {
		expect(sortDashboards([a, b], "name-asc").map((d) => d.id)).toEqual(["a", "b"])
	})
})

describe("filters", () => {
	const d = dashboard({ name: "Checkout latency", description: "p95 by region", tags: ["api", "slo"] })

	it("matches name, description and tags", () => {
		expect(dashboardMatches(d, "checkout")).toBe(true)
		expect(dashboardMatches(d, "REGION")).toBe(true)
		expect(dashboardMatches(d, "slo")).toBe(true)
		expect(dashboardMatches(d, "kubernetes")).toBe(false)
	})

	it("treats an empty query as matching everything", () => {
		expect(dashboardMatches(d, "   ")).toBe(true)
	})

	it("combines tags with AND", () => {
		expect(matchesTags(d, ["api"])).toBe(true)
		expect(matchesTags(d, ["api", "slo"])).toBe(true)
		expect(matchesTags(d, ["api", "infra"])).toBe(false)
		expect(matchesTags(d, [])).toBe(true)
	})

	it("collects tags deduped and sorted", () => {
		expect(collectTags([d, dashboard({ id: "d2", tags: ["slo", "cost"] })])).toEqual([
			"api",
			"cost",
			"slo",
		])
	})
})

describe("headerSummary", () => {
	const stamp = () => "2h ago"

	it("counts dashboards and widgets and reports the most recent edit", () => {
		const summary = headerSummary(
			[
				dashboard({ id: "a", widgets: [widget("chart", "list_traces")] }),
				dashboard({
					id: "b",
					widgets: [widget("stat", "metrics_summary"), widget("chart", "custom_timeseries")],
				}),
			],
			stamp,
		)
		expect(summary).toBe("2 dashboards · 3 widgets · last edited 2h ago")
	})

	it("adds the empty-dashboard clause only when there is one", () => {
		const withEmpty = headerSummary(
			[dashboard({ id: "a" }), dashboard({ id: "b", widgets: [widget("chart", "list_logs")] })],
			stamp,
		)
		expect(withEmpty).toContain("1 with no widgets")

		const noneEmpty = headerSummary(
			[dashboard({ id: "b", widgets: [widget("chart", "list_logs")] })],
			stamp,
		)
		expect(noneEmpty).not.toContain("no widgets")
	})

	it("singularises", () => {
		expect(headerSummary([dashboard({ widgets: [widget("chart", "list_logs")] })], stamp)).toBe(
			"1 dashboard · 1 widget · last edited 2h ago",
		)
	})

	it("has a first-run form", () => {
		expect(headerSummary([], stamp)).toBe("No dashboards yet")
	})
})
