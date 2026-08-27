import { describe, expect, it } from "vitest"

import { errorFilterChips } from "./error-filter-chips"

describe("errorFilterChips", () => {
	it("is empty when nothing is filtered", () => {
		expect(errorFilterChips({})).toEqual([])
	})

	it("puts exclusions ahead of inclusions", () => {
		const chips = errorFilterChips({ services: ["api"], excludedErrorTypes: ["TimeoutError"] })
		expect(chips.map((c) => [c.label, c.negated])).toEqual([
			["Error Type", true],
			["Service", false],
		])
	})

	it("names the param each chip clears", () => {
		expect(errorFilterChips({ excludedServiceVersions: ["1.4.2"] })).toEqual([
			{
				param: "excludedServiceVersions",
				label: "Version",
				values: ["1.4.2"],
				negated: true,
			},
		])
	})

	it("ignores params present but empty", () => {
		expect(errorFilterChips({ services: [], excludedServices: [] })).toEqual([])
	})
})
