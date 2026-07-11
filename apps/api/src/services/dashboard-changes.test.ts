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
