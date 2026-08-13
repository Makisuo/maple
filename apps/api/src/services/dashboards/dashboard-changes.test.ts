import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { DashboardDocument, type DashboardVariable } from "@maple/domain/http"

import { summarizeDashboardChange } from "./dashboard-changes"

const decodeDocument = Schema.decodeUnknownSync(DashboardDocument)

const makeDocument = (variables?: DashboardVariable[]) =>
	decodeDocument({
		id: "dash-1",
		name: "Test",
		timeRange: { type: "relative", value: "12h" },
		widgets: [],
		...(variables !== undefined && { variables }),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	})

const serviceVariable: DashboardVariable = {
	name: "service",
	type: "query",
	source: { kind: "facet", facet: "service" },
}

describe("summarizeDashboardChange — variables", () => {
	it("emits variables_changed when variables are added", () => {
		const summary = summarizeDashboardChange(makeDocument(), makeDocument([serviceVariable]))
		expect(summary).toEqual({ kind: "variables_changed", summary: "Variables updated" })
	})

	it("emits variables_changed when variables are removed", () => {
		const summary = summarizeDashboardChange(makeDocument([serviceVariable]), makeDocument([]))
		expect(summary.kind).toBe("variables_changed")
	})

	it("treats a missing array and an empty array as equal", () => {
		const summary = summarizeDashboardChange(makeDocument(), makeDocument([]))
		expect(summary).toEqual({ kind: "multiple", summary: "No changes" })
	})

	it("reports no change for identical variables", () => {
		const summary = summarizeDashboardChange(
			makeDocument([serviceVariable]),
			makeDocument([serviceVariable]),
		)
		expect(summary).toEqual({ kind: "multiple", summary: "No changes" })
	})
})

const decodeSectioned = (input: { widgets?: unknown[]; sections?: unknown[] }) =>
	decodeDocument({
		id: "dash-1",
		name: "Test",
		timeRange: { type: "relative", value: "12h" },
		widgets: input.widgets ?? [],
		...(input.sections !== undefined && { sections: input.sections }),
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	})

const overview = { id: "s1", title: "Overview", tabs: [{ id: "t1", title: "Latency" }] }
const errors = { id: "s2", title: "Errors", tabs: [{ id: "t2", title: "Rates" }] }

const sectionWidget = (id: string, membership: Record<string, string> = {}) => ({
	id,
	visualization: "chart",
	dataSource: { endpoint: "custom_query_builder_timeseries" },
	display: {},
	layout: { x: 0, y: 0, w: 4, h: 4 },
	...membership,
})

describe("summarizeDashboardChange — sections", () => {
	it("emits section_added with the group name", () => {
		const summary = summarizeDashboardChange(
			decodeSectioned({}),
			decodeSectioned({ sections: [overview] }),
		)
		expect(summary).toEqual({ kind: "section_added", summary: 'Added group "Overview"' })
	})

	it("emits section_removed", () => {
		const summary = summarizeDashboardChange(
			decodeSectioned({ sections: [overview] }),
			decodeSectioned({ sections: [] }),
		)
		expect(summary).toEqual({ kind: "section_removed", summary: 'Removed group "Overview"' })
	})

	// Renames, tab edits, reordering and the collapse default all collapse into
	// one kind on purpose.
	it("emits section_updated for a rename", () => {
		const summary = summarizeDashboardChange(
			decodeSectioned({ sections: [overview] }),
			decodeSectioned({ sections: [{ ...overview, title: "Golden signals" }] }),
		)
		expect(summary).toEqual({ kind: "section_updated", summary: "Groups updated" })
	})

	it("emits section_updated for a tab add", () => {
		const summary = summarizeDashboardChange(
			decodeSectioned({ sections: [overview] }),
			decodeSectioned({
				sections: [{ ...overview, tabs: [...overview.tabs, { id: "t9", title: "Saturation" }] }],
			}),
		)
		expect(summary.kind).toBe("section_updated")
	})

	it("emits section_updated for a reorder", () => {
		const summary = summarizeDashboardChange(
			decodeSectioned({ sections: [overview, errors] }),
			decodeSectioned({ sections: [errors, overview] }),
		)
		expect(summary.kind).toBe("section_updated")
	})

	it("treats a missing array and an empty array as equal", () => {
		const summary = summarizeDashboardChange(decodeSectioned({}), decodeSectioned({ sections: [] }))
		expect(summary).toEqual({ kind: "multiple", summary: "No changes" })
	})

	// Membership is a layout act: `layout.x/y` are container-relative, so moving a
	// tile between groups is a repositioning.
	it("reports moving a widget between groups as layout_changed", () => {
		const summary = summarizeDashboardChange(
			decodeSectioned({
				widgets: [sectionWidget("w1", { sectionId: "s1", tabId: "t1" })],
				sections: [overview, errors],
			}),
			decodeSectioned({
				widgets: [sectionWidget("w1", { sectionId: "s2", tabId: "t2" })],
				sections: [overview, errors],
			}),
		)
		expect(summary).toEqual({ kind: "layout_changed", summary: "Layout changed" })
	})

	it("reports ungrouping a widget as layout_changed", () => {
		const summary = summarizeDashboardChange(
			decodeSectioned({
				widgets: [sectionWidget("w1", { sectionId: "s1", tabId: "t1" })],
				sections: [overview],
			}),
			decodeSectioned({ widgets: [sectionWidget("w1")], sections: [overview] }),
		)
		expect(summary.kind).toBe("layout_changed")
	})

	it("reports a rename plus a group add as multiple", () => {
		const prev = decodeSectioned({})
		const next = decodeDocument({
			id: "dash-1",
			name: "Renamed",
			timeRange: { type: "relative", value: "12h" },
			widgets: [],
			sections: [overview],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		})
		expect(summarizeDashboardChange(prev, next)).toEqual({
			kind: "multiple",
			summary: "Multiple changes",
		})
	})
})
