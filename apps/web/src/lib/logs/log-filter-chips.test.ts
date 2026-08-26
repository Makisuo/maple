import { describe, expect, it } from "vitest"

import { logFilterChips } from "./log-filter-chips"

describe("logFilterChips", () => {
	it("is empty when nothing is filtered", () => {
		expect(logFilterChips({})).toEqual([])
	})

	it("puts exclusions ahead of inclusions", () => {
		const chips = logFilterChips({ services: ["api"], excludedSeverities: ["DEBUG"] })
		expect(chips.map((c) => [c.label, c.negated])).toEqual([
			["Severity", true],
			["Service", false],
		])
	})

	it("names the param each chip clears", () => {
		expect(logFilterChips({ excludedServices: ["noisy"] })).toEqual([
			{ param: "excludedServices", label: "Service", values: ["noisy"], negated: true },
		])
	})

	it("ignores params present but empty", () => {
		expect(logFilterChips({ services: [], excludedServices: [] })).toEqual([])
	})
})
