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

	it("puts the trace scope ahead of everything, exclusions included", () => {
		const traceId = "0af7651916cd43dd8448eb211c80319c"
		const chips = logFilterChips({ traceId, excludedSeverities: ["DEBUG"], services: ["api"] })
		expect(chips.map((c) => [c.label, c.negated])).toEqual([
			["Trace", false],
			["Severity", true],
			["Service", false],
		])
		expect(chips[0]).toEqual({ param: "traceId", label: "Trace", values: [traceId], negated: false })
	})
})
