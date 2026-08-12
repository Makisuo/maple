import { describe, expect, it } from "vitest"

import {
	activeTabIdFor,
	isSectionCollapsed,
	parseActiveTabs,
	parseIdList,
	resolveSectionView,
	withActiveTab,
	withSectionCollapsed,
} from "./section-view-state"
import type { DashboardSection, DashboardWidget } from "@/components/dashboard-builder/types"

const section = (
	id: string,
	tabIds: ReadonlyArray<string> = ["t1"],
	collapsed?: boolean,
): DashboardSection => ({
	id,
	title: id,
	...(collapsed !== undefined ? { collapsed } : {}),
	tabs: tabIds.map((tabId) => ({ id: tabId, title: tabId })),
})

const widget = (id: string, membership?: { sectionId: string; tabId: string }): DashboardWidget => ({
	id,
	visualization: "chart",
	dataSource: { endpoint: "custom_query_builder_timeseries" },
	display: {},
	layout: { x: 0, y: 0, w: 4, h: 4 },
	...(membership ?? {}),
})

describe("parseIdList", () => {
	it("returns an empty set for absent or empty input", () => {
		expect(parseIdList(undefined).size).toBe(0)
		expect(parseIdList("").size).toBe(0)
	})

	it("trims and drops empty entries", () => {
		expect([...parseIdList("a, b ,,c,")]).toEqual(["a", "b", "c"])
	})
})

describe("parseActiveTabs", () => {
	it("parses well-formed pairs", () => {
		expect([...parseActiveTabs("s1:t1,s2:t2")]).toEqual([
			["s1", "t1"],
			["s2", "t2"],
		])
	})

	// A hand-edited URL must never crash the route.
	it("drops malformed entries without throwing", () => {
		expect([...parseActiveTabs("::,,,a:b,:x,y:,z")]).toEqual([["a", "b"]])
	})

	// Tab ids are opaque; a colon inside one must not truncate it.
	it("splits on the first separator only", () => {
		expect(parseActiveTabs("s1:a:b").get("s1")).toBe("a:b")
	})
})

describe("isSectionCollapsed", () => {
	it("falls back to the stored default", () => {
		expect(isSectionCollapsed(section("s1", ["t1"], true), {})).toBe(true)
		expect(isSectionCollapsed(section("s1"), {})).toBe(false)
	})

	it("lets a viewer override the stored default in both directions", () => {
		expect(isSectionCollapsed(section("s1", ["t1"], true), { expanded: "s1" })).toBe(false)
		expect(isSectionCollapsed(section("s1"), { collapsed: "s1" })).toBe(true)
	})

	// `expanded` winning is what makes the widget deep link able to force a
	// section open.
	it("prefers expanded over collapsed", () => {
		expect(isSectionCollapsed(section("s1"), { collapsed: "s1", expanded: "s1" })).toBe(false)
	})
})

describe("activeTabIdFor", () => {
	it("uses the requested tab", () => {
		expect(activeTabIdFor(section("s1", ["t1", "t2"]), { tab: "s1:t2" })).toBe("t2")
	})

	it("falls back to the first tab for an unknown tab id", () => {
		expect(activeTabIdFor(section("s1", ["t1", "t2"]), { tab: "s1:gone" })).toBe("t1")
	})

	it("falls back to the first tab when unspecified", () => {
		expect(activeTabIdFor(section("s1", ["t1", "t2"]), {})).toBe("t1")
	})
})

describe("withSectionCollapsed", () => {
	// The regression this guards: without removing from the opposite list, a
	// section toggled repeatedly accumulates in both, the URL grows without
	// bound, and `expanded` pins it permanently open.
	it("removes the id from the opposite list", () => {
		const collapsedThenExpanded = withSectionCollapsed({ collapsed: "s1" }, "s1", false)
		expect(collapsedThenExpanded.collapsed).toBeUndefined()
		expect(collapsedThenExpanded.expanded).toBe("s1")

		const backToCollapsed = withSectionCollapsed(collapsedThenExpanded, "s1", true)
		expect(backToCollapsed.expanded).toBeUndefined()
		expect(backToCollapsed.collapsed).toBe("s1")
	})

	it("does not grow the URL across repeated toggles", () => {
		let search = withSectionCollapsed({}, "s1", true)
		for (let i = 0; i < 5; i += 1) {
			search = withSectionCollapsed(search, "s1", false)
			search = withSectionCollapsed(search, "s1", true)
		}
		expect(search.collapsed).toBe("s1")
		expect(search.expanded).toBeUndefined()
	})

	it("leaves other sections alone", () => {
		const next = withSectionCollapsed({ collapsed: "s1,s2" }, "s1", false)
		expect(next.collapsed).toBe("s2")
		expect(next.expanded).toBe("s1")
	})
})

describe("withActiveTab", () => {
	it("adds and replaces pairs", () => {
		expect(withActiveTab({}, "s1", "t1").tab).toBe("s1:t1")
		expect(withActiveTab({ tab: "s1:t1" }, "s1", "t2").tab).toBe("s1:t2")
		expect(withActiveTab({ tab: "s1:t1" }, "s2", "t2").tab).toBe("s1:t1,s2:t2")
	})
})

describe("resolveSectionView", () => {
	const sections = [section("s1", ["t1", "t2"], true), section("s2", ["t3"])]

	it("resolves collapse and active tab for every section in one pass", () => {
		const view = resolveSectionView(sections, [], {})
		expect([...view.collapsed]).toEqual(["s1"])
		expect(view.activeTabs.get("s1")).toBe("t1")
		expect(view.activeTabs.get("s2")).toBe("t3")
	})

	// Resolved as a derivation rather than an effect: expanding after mount
	// would mount the target tile, unmount it and remount it, firing its query
	// twice.
	it("force-expands and tab-switches to a deep-linked widget", () => {
		const widgets = [widget("w1", { sectionId: "s1", tabId: "t2" })]
		const view = resolveSectionView(sections, widgets, { widget: "w1" })
		expect(view.collapsed.has("s1")).toBe(false)
		expect(view.activeTabs.get("s1")).toBe("t2")
	})

	it("ignores a deep link to a widget that no longer exists", () => {
		const view = resolveSectionView(sections, [], { widget: "gone" })
		expect([...view.collapsed]).toEqual(["s1"])
	})

	it("ignores a deep link to an ungrouped widget", () => {
		const view = resolveSectionView(sections, [widget("w1")], { widget: "w1" })
		expect([...view.collapsed]).toEqual(["s1"])
	})

	it("honours a viewer's explicit collapse over the deep link's own section only", () => {
		const widgets = [widget("w1", { sectionId: "s2", tabId: "t3" })]
		const view = resolveSectionView(sections, widgets, { widget: "w1", collapsed: "s1,s2" })
		expect(view.collapsed.has("s2")).toBe(false)
		expect(view.collapsed.has("s1")).toBe(true)
	})
})
