import { describe, expect, it } from "vitest"

import {
	autoLayoutPerContainer,
	containerRank,
	findNextPosition,
	rootBottom,
	sortWidgetsForLayout,
	ungroupSectionWidgets,
	widgetsInContainer,
} from "./section-layout"
import type { DashboardSection, DashboardWidget } from "@/components/dashboard-builder/types"

const widget = (
	id: string,
	layout: { x: number; y: number; w: number; h: number },
	membership?: { sectionId: string; tabId: string },
): DashboardWidget => ({
	id,
	visualization: "chart",
	dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
	display: {},
	layout,
	...(membership ?? {}),
})

const section = (id: string, tabIds: ReadonlyArray<string>): DashboardSection => ({
	id,
	title: id,
	tabs: tabIds.map((tabId) => ({ id: tabId, title: tabId })),
})

describe("findNextPosition", () => {
	it("starts an empty container at the origin", () => {
		expect(findNextPosition([], 6)).toEqual({ x: 0, y: 0 })
	})

	it("fills the bottom row left to right while it fits", () => {
		const widgets = [widget("a", { x: 0, y: 0, w: 6, h: 4 })]
		expect(findNextPosition(widgets, 6)).toEqual({ x: 6, y: 0 })
	})

	it("wraps to a new row when the widget does not fit", () => {
		const widgets = [widget("a", { x: 0, y: 0, w: 8, h: 4 })]
		expect(findNextPosition(widgets, 6)).toEqual({ x: 0, y: 4 })
	})

	// The container-scoping contract: passing the whole board would place a
	// grouped widget below tiles it will never share a grid with.
	it("ignores widgets in other containers when given a scoped subset", () => {
		const board = [
			widget("root", { x: 0, y: 0, w: 12, h: 20 }),
			widget("grouped", { x: 0, y: 0, w: 4, h: 4 }, { sectionId: "s1", tabId: "t1" }),
		]
		const scoped = widgetsInContainer(board, { sectionId: "s1", tabId: "t1" })
		expect(findNextPosition(scoped, 4)).toEqual({ x: 4, y: 0 })
	})
})

describe("containerRank", () => {
	const sections = [section("s1", ["t1", "t2"]), section("s2", ["t3"])]

	it("ranks root before every section", () => {
		expect(containerRank(widget("a", { x: 0, y: 0, w: 1, h: 1 }), sections)).toBe(-1)
	})

	it("ranks sections and tabs in declaration order", () => {
		const first = widget("a", { x: 0, y: 0, w: 1, h: 1 }, { sectionId: "s1", tabId: "t1" })
		const second = widget("b", { x: 0, y: 0, w: 1, h: 1 }, { sectionId: "s1", tabId: "t2" })
		const third = widget("c", { x: 0, y: 0, w: 1, h: 1 }, { sectionId: "s2", tabId: "t3" })
		expect(containerRank(first, sections)).toBeLessThan(containerRank(second, sections))
		expect(containerRank(second, sections)).toBeLessThan(containerRank(third, sections))
	})

	it("ranks a widget whose container vanished as root, matching where it renders", () => {
		const orphan = widget("a", { x: 0, y: 0, w: 1, h: 1 }, { sectionId: "gone", tabId: "t1" })
		expect(containerRank(orphan, sections)).toBe(-1)
	})
})

describe("sortWidgetsForLayout", () => {
	// The regression this comparator exists for: each container restarts at
	// `y: 0`, so sorting on (y, x) alone interleaves the sections.
	it("keeps each container's widgets contiguous", () => {
		const sections = [section("s1", ["t1"]), section("s2", ["t2"])]
		const widgets = [
			widget("s2-top", { x: 0, y: 0, w: 4, h: 4 }, { sectionId: "s2", tabId: "t2" }),
			widget("root-low", { x: 0, y: 8, w: 4, h: 4 }),
			widget("s1-top", { x: 0, y: 0, w: 4, h: 4 }, { sectionId: "s1", tabId: "t1" }),
			widget("root-top", { x: 0, y: 0, w: 4, h: 4 }),
			widget("s1-low", { x: 0, y: 4, w: 4, h: 4 }, { sectionId: "s1", tabId: "t1" }),
		]
		expect(sortWidgetsForLayout(widgets, sections).map((w) => w.id)).toEqual([
			"root-top",
			"root-low",
			"s1-top",
			"s1-low",
			"s2-top",
		])
	})

	it("orders by (y, x) within one container", () => {
		const widgets = [
			widget("c", { x: 0, y: 4, w: 4, h: 4 }),
			widget("b", { x: 6, y: 0, w: 4, h: 4 }),
			widget("a", { x: 0, y: 0, w: 4, h: 4 }),
		]
		expect(sortWidgetsForLayout(widgets, []).map((w) => w.id)).toEqual(["a", "b", "c"])
	})
})

describe("ungroupSectionWidgets", () => {
	it("offsets ungrouped widgets below the existing root content", () => {
		const widgets = [
			widget("root", { x: 0, y: 0, w: 12, h: 6 }),
			widget("g1", { x: 0, y: 0, w: 4, h: 4 }, { sectionId: "s1", tabId: "t1" }),
			widget("g2", { x: 4, y: 4, w: 4, h: 4 }, { sectionId: "s1", tabId: "t1" }),
		]
		const result = ungroupSectionWidgets(widgets, "s1")
		expect(result.find((w) => w.id === "g1")?.layout.y).toBe(6)
		expect(result.find((w) => w.id === "g2")?.layout.y).toBe(10)
	})

	// `sectionId`/`tabId` are optionalKey on the document — a present `undefined`
	// fails the encode, so ungrouping must remove the keys.
	it("strips both membership keys", () => {
		const widgets = [widget("g1", { x: 0, y: 0, w: 4, h: 4 }, { sectionId: "s1", tabId: "t1" })]
		const [ungrouped] = ungroupSectionWidgets(widgets, "s1")
		expect("sectionId" in ungrouped!).toBe(false)
		expect("tabId" in ungrouped!).toBe(false)
	})

	it("leaves other sections untouched", () => {
		const widgets = [
			widget("keep", { x: 0, y: 2, w: 4, h: 4 }, { sectionId: "s2", tabId: "t2" }),
			widget("move", { x: 0, y: 0, w: 4, h: 4 }, { sectionId: "s1", tabId: "t1" }),
		]
		const kept = ungroupSectionWidgets(widgets, "s1").find((w) => w.id === "keep")
		expect(kept?.sectionId).toBe("s2")
		expect(kept?.layout.y).toBe(2)
	})

	it("drops widgets at the origin when the root canvas is empty", () => {
		const widgets = [widget("g1", { x: 0, y: 0, w: 4, h: 4 }, { sectionId: "s1", tabId: "t1" })]
		expect(ungroupSectionWidgets(widgets, "s1")[0]?.layout.y).toBe(0)
	})
})

describe("rootBottom", () => {
	it("ignores grouped widgets", () => {
		const widgets = [
			widget("root", { x: 0, y: 0, w: 4, h: 3 }),
			widget("deep", { x: 0, y: 40, w: 4, h: 4 }, { sectionId: "s1", tabId: "t1" }),
		]
		expect(rootBottom(widgets)).toBe(3)
	})
})

describe("autoLayoutPerContainer", () => {
	it("restarts each container at the origin", () => {
		const sections = [section("s1", ["t1"]), section("s2", ["t2"])]
		const widgets = [
			widget("root", { x: 3, y: 9, w: 6, h: 4 }),
			widget("a", { x: 5, y: 20, w: 6, h: 4 }, { sectionId: "s1", tabId: "t1" }),
			widget("b", { x: 5, y: 30, w: 6, h: 4 }, { sectionId: "s1", tabId: "t1" }),
			widget("c", { x: 2, y: 50, w: 6, h: 4 }, { sectionId: "s2", tabId: "t2" }),
		]
		const relaid = autoLayoutPerContainer(widgets, sections)
		const byId = new Map(relaid.map((w) => [w.id, w.layout]))
		expect(byId.get("root")).toMatchObject({ x: 0, y: 0 })
		expect(byId.get("a")).toMatchObject({ x: 0, y: 0 })
		expect(byId.get("b")).toMatchObject({ x: 6, y: 0 })
		expect(byId.get("c")).toMatchObject({ x: 0, y: 0 })
	})

	it("wraps within a container at the canonical column count", () => {
		const sections = [section("s1", ["t1"])]
		const widgets = [
			widget("a", { x: 0, y: 0, w: 8, h: 4 }, { sectionId: "s1", tabId: "t1" }),
			widget("b", { x: 8, y: 0, w: 8, h: 5 }, { sectionId: "s1", tabId: "t1" }),
		]
		const byId = new Map(autoLayoutPerContainer(widgets, sections).map((w) => [w.id, w.layout]))
		expect(byId.get("b")).toMatchObject({ x: 0, y: 4 })
	})

	it("returns widgets in visual order", () => {
		const sections = [section("s1", ["t1"])]
		const widgets = [
			widget("grouped", { x: 0, y: 0, w: 4, h: 4 }, { sectionId: "s1", tabId: "t1" }),
			widget("root", { x: 0, y: 0, w: 4, h: 4 }),
		]
		expect(autoLayoutPerContainer(widgets, sections).map((w) => w.id)).toEqual(["root", "grouped"])
	})
})
