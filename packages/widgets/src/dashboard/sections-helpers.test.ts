import { describe, expect, it } from "vitest"

import {
	ROOT_CONTAINER_KEY,
	containerKeyOf,
	groupWidgetsByContainer,
	rootWidgets,
	sanitizeDashboardSections,
	widgetsInTab,
	withSectionTarget,
} from "./sections-helpers"
import {
	DASHBOARD_MAX_SECTIONS,
	DASHBOARD_MAX_TABS_PER_SECTION,
	type DashboardSection,
} from "./shared/sections"

interface TestWidget {
	id: string
	sectionId?: string | undefined
	tabId?: string | undefined
}

const widget = (id: string, sectionId?: string, tabId?: string): TestWidget => {
	const w: TestWidget = { id }
	if (sectionId !== undefined) w.sectionId = sectionId
	if (tabId !== undefined) w.tabId = tabId
	return w
}

const section = (id: string, tabIds: ReadonlyArray<string>): DashboardSection => ({
	id,
	title: id,
	tabs: tabIds.map((tabId) => ({ id: tabId, title: tabId })),
})

describe("containerKeyOf", () => {
	it("treats a widget with no membership as root", () => {
		expect(containerKeyOf(widget("w1"))).toBe(ROOT_CONTAINER_KEY)
	})

	// A half-address can't identify a grid, so it renders at the root rather than
	// creating a phantom container.
	it("treats a half-address as root", () => {
		expect(containerKeyOf(widget("w1", "s1"))).toBe(ROOT_CONTAINER_KEY)
		expect(containerKeyOf(widget("w1", undefined, "t1"))).toBe(ROOT_CONTAINER_KEY)
	})

	// The separator must not be forgeable from ids, or two distinct containers
	// could collide on one key.
	it("distinguishes containers whose ids share a prefix", () => {
		expect(containerKeyOf(widget("w", "a", "bc"))).not.toBe(containerKeyOf(widget("w", "ab", "c")))
	})
})

describe("withSectionTarget", () => {
	// `sectionId`/`tabId` are `Schema.optionalKey`, so ungrouping has to remove
	// the keys — a present `undefined` fails the document encode.
	it("removes the keys entirely when ungrouping", () => {
		const ungrouped = withSectionTarget(widget("w1", "s1", "t1"), null)
		expect("sectionId" in ungrouped).toBe(false)
		expect("tabId" in ungrouped).toBe(false)
	})

	it("does not mutate the input", () => {
		const original = widget("w1", "s1", "t1")
		withSectionTarget(original, null)
		expect(original.sectionId).toBe("s1")
	})

	it("assigns both ids together", () => {
		expect(withSectionTarget(widget("w1"), { sectionId: "s1", tabId: "t1" })).toEqual({
			id: "w1",
			sectionId: "s1",
			tabId: "t1",
		})
	})
})

describe("groupWidgetsByContainer", () => {
	it("buckets widgets by container, preserving document order", () => {
		const doc = {
			widgets: [widget("a", "s1", "t1"), widget("b"), widget("c", "s1", "t1"), widget("d", "s1", "t2")],
			sections: [section("s1", ["t1", "t2"])],
		}
		expect(widgetsInTab(doc, "s1", "t1").map((w) => w.id)).toEqual(["a", "c"])
		expect(widgetsInTab(doc, "s1", "t2").map((w) => w.id)).toEqual(["d"])
		expect(rootWidgets(doc).map((w) => w.id)).toEqual(["b"])
	})

	// An empty group must still render — otherwise adding a group and then
	// looking away loses it.
	it("declares a bucket for every tab, including empty ones", () => {
		const grouped = groupWidgetsByContainer({ widgets: [], sections: [section("s1", ["t1", "t2"])] })
		expect(grouped.size).toBe(3) // root + two tabs
	})

	// Storage is repaired on write, but a stale in-memory document must not drop
	// tiles on the floor.
	it("falls back to root for a widget addressing a missing container", () => {
		const doc = { widgets: [widget("a", "gone", "t1")], sections: [section("s1", ["t1"])] }
		expect(rootWidgets(doc).map((w) => w.id)).toEqual(["a"])
	})
})

describe("sanitizeDashboardSections", () => {
	// The load-bearing property: every pre-sections document must be untouched,
	// so the write path can call this unconditionally.
	it("returns the same reference when there are no sections", () => {
		const doc = { widgets: [widget("a"), widget("b")] }
		expect(sanitizeDashboardSections(doc)).toBe(doc)
	})

	it("returns the same reference when nothing needs repair", () => {
		const doc = { widgets: [widget("a", "s1", "t1")], sections: [section("s1", ["t1"])] }
		expect(sanitizeDashboardSections(doc)).toBe(doc)
	})

	it("ungroups a widget whose section is gone", () => {
		const doc = { widgets: [widget("a", "gone", "t1")], sections: [section("s1", ["t1"])] }
		const [repaired] = sanitizeDashboardSections(doc).widgets
		expect("sectionId" in repaired!).toBe(false)
		expect("tabId" in repaired!).toBe(false)
	})

	it("reassigns a dangling tabId to the section's first tab", () => {
		const doc = { widgets: [widget("a", "s1", "gone")], sections: [section("s1", ["t1", "t2"])] }
		expect(sanitizeDashboardSections(doc).widgets[0]).toEqual({
			id: "a",
			sectionId: "s1",
			tabId: "t1",
		})
	})

	it("assigns a tabId to a widget that has only a sectionId", () => {
		const doc = { widgets: [widget("a", "s1")], sections: [section("s1", ["t1"])] }
		expect(sanitizeDashboardSections(doc).widgets[0]?.tabId).toBe("t1")
	})

	it("drops a tabId that has no sectionId", () => {
		const doc = { widgets: [widget("a", undefined, "t1")], sections: [section("s1", ["t1"])] }
		expect("tabId" in sanitizeDashboardSections(doc).widgets[0]!).toBe(false)
	})

	it("synthesises a tab for a section that has none", () => {
		const doc = { widgets: [], sections: [{ id: "s1", title: "Overview", tabs: [] }] }
		expect(sanitizeDashboardSections(doc).sections?.[0]?.tabs).toEqual([{ id: "s1", title: "Overview" }])
	})

	it("de-dupes section and tab ids, first writer wins", () => {
		const doc = {
			widgets: [],
			sections: [
				{
					id: "s1",
					title: "First",
					tabs: [
						{ id: "t1", title: "A" },
						{ id: "t1", title: "B" },
					],
				},
				{ id: "s1", title: "Second", tabs: [{ id: "t9", title: "C" }] },
			],
		}
		const sections = sanitizeDashboardSections(doc).sections
		expect(sections).toHaveLength(1)
		expect(sections?.[0]?.title).toBe("First")
		expect(sections?.[0]?.tabs).toEqual([{ id: "t1", title: "A" }])
	})

	it("caps sections and tabs", () => {
		const doc = {
			widgets: [],
			sections: [
				section(
					"s1",
					Array.from({ length: DASHBOARD_MAX_TABS_PER_SECTION + 5 }, (_, i) => `t${i}`),
				),
				...Array.from({ length: DASHBOARD_MAX_SECTIONS + 5 }, (_, i) => section(`x${i}`, ["t"])),
			],
		}
		const sections = sanitizeDashboardSections(doc).sections
		expect(sections).toHaveLength(DASHBOARD_MAX_SECTIONS)
		expect(sections?.[0]?.tabs).toHaveLength(DASHBOARD_MAX_TABS_PER_SECTION)
	})

	// A widget dropped by the section cap must be ungrouped, not left addressing
	// a section that is no longer in the document.
	it("ungroups widgets whose section was cut by the cap", () => {
		const sections = Array.from({ length: DASHBOARD_MAX_SECTIONS + 1 }, (_, i) => section(`s${i}`, ["t"]))
		const doomed = sections[DASHBOARD_MAX_SECTIONS]!
		const doc = { widgets: [widget("a", doomed.id, "t")], sections }
		expect("sectionId" in sanitizeDashboardSections(doc).widgets[0]!).toBe(false)
	})

	// "Collapsed by default" + "can never be collapsed" would render the group
	// folded with no chevron to unfold it. `collapsible: false` is the stronger
	// claim, so it wins and the stale default is dropped.
	it("clears `collapsed` on a section that cannot be collapsed", () => {
		const doc = {
			widgets: [],
			sections: [
				{
					id: "s1",
					title: "S",
					collapsed: true,
					collapsible: false,
					tabs: [{ id: "t1", title: "T" }],
				},
			],
		}
		const repaired = sanitizeDashboardSections(doc).sections?.[0]
		expect("collapsed" in repaired!).toBe(false)
		expect(repaired!.collapsible).toBe(false)
	})

	it("leaves a collapsible section's stored default alone", () => {
		const doc = {
			widgets: [],
			sections: [{ id: "s1", title: "S", collapsed: true, tabs: [{ id: "t1", title: "T" }] }],
		}
		expect(sanitizeDashboardSections(doc)).toBe(doc)
	})

	it("allows a pinned-open section that was never collapsed", () => {
		const doc = {
			widgets: [],
			sections: [{ id: "s1", title: "S", collapsible: false, tabs: [{ id: "t1", title: "T" }] }],
		}
		expect(sanitizeDashboardSections(doc)).toBe(doc)
	})

	it("is idempotent", () => {
		const doc = {
			widgets: [widget("a", "s1", "gone"), widget("b", "missing", "t1")],
			sections: [{ id: "s1", title: "S", tabs: [] }],
		}
		const once = sanitizeDashboardSections(doc)
		const twice = sanitizeDashboardSections(once)
		expect(twice).toStrictEqual(once)
		// Second pass has nothing left to repair, so it short-circuits by reference.
		expect(twice).toBe(once)
	})
})
