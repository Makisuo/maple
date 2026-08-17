import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { DashboardDocument, DashboardSectionSchema } from "@maple/domain/http"

import { documentToDashboard } from "./dashboards"

const decodeDocument = Schema.decodeUnknownSync(DashboardDocument)

const baseDocument = {
	id: "dash-1",
	name: "Test",
	timeRange: { type: "relative", value: "12h" },
	widgets: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
}

/**
 * Every field the section schema declares, populated with a non-default value.
 * The completeness test below diffs against this, so adding a field to
 * `DashboardSectionSchema` without adding it here fails loudly rather than
 * silently vanishing on the read path.
 */
const fullSection = {
	id: "s1",
	title: "Overview",
	collapsed: false,
	collapsible: false,
	tabs: [{ id: "t1", title: "Latency" }],
}

describe("documentToDashboard — section widening", () => {
	it("round-trips every declared section field", () => {
		const decoded = decodeDocument({ ...baseDocument, sections: [fullSection] })
		expect(documentToDashboard(decoded).sections?.[0]).toEqual(fullSection)
	})

	/**
	 * `widenSections` rebuilds each section field by field, so a newly-declared
	 * field is dropped unless it is added there too — and because every section
	 * field is optional, TypeScript cannot catch the omission. This has now bitten
	 * three times (`sections` on the API create path, `collapsible` here), so the
	 * guard is derived from the schema rather than hand-listed.
	 */
	it("copies every key the schema declares", () => {
		const declared = Object.keys(DashboardSectionSchema.fields)
		expect(Object.keys(fullSection).sort()).toEqual(declared.sort())

		const decoded = decodeDocument({ ...baseDocument, sections: [fullSection] })
		const widened = documentToDashboard(decoded).sections?.[0] ?? {}
		expect(Object.keys(widened).sort()).toEqual(declared.sort())
	})

	it("omits absent optional fields rather than stamping undefined", () => {
		const decoded = decodeDocument({
			...baseDocument,
			sections: [{ id: "s1", title: "Overview", tabs: [{ id: "t1", title: "T" }] }],
		})
		const widened = documentToDashboard(decoded).sections?.[0]
		expect("collapsed" in widened!).toBe(false)
		expect("collapsible" in widened!).toBe(false)
	})

	it("leaves a document without sections undefined", () => {
		expect(documentToDashboard(decodeDocument(baseDocument)).sections).toBeUndefined()
	})
})
