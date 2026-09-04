import { describe, expect, it } from "vitest"

import { errorFilterChips, hasErrorFilters } from "./error-filter-chips"

describe("errorFilterChips", () => {
	it("is empty when nothing is filtered", () => {
		expect(errorFilterChips({})).toEqual([])
		expect(hasErrorFilters({})).toBe(false)
	})

	it("keeps the sidebar's order", () => {
		const chips = errorFilterChips({ regressed: true, kind: "alert", service: "api" })
		expect(chips.map((c) => c.label)).toEqual(["Service", "Source", "State"])
	})

	it("names the param each chip clears and labels fixed vocabularies", () => {
		expect(errorFilterChips({ kind: "integration", regressed: true })).toEqual([
			{ param: "kind", label: "Source", values: ["Integrations"] },
			{ param: "regressed", label: "State", values: ["Regressed"] },
		])
	})

	it("ignores an unset regression toggle and an empty environment", () => {
		expect(errorFilterChips({ regressed: false, env: "" })).toEqual([])
	})
})
