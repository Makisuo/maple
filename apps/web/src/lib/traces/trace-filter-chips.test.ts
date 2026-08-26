import { describe, expect, it } from "vitest"

import { traceFilterChips } from "./trace-filter-chips"

describe("traceFilterChips", () => {
	it("is empty when nothing is filtered", () => {
		expect(traceFilterChips({})).toEqual([])
	})

	it("puts exclusions ahead of inclusions", () => {
		// An inclusion explains itself — the results are what came back. An exclusion is only
		// visible as absence, so it reads first.
		const chips = traceFilterChips({
			services: ["api"],
			excludedSpanNames: ["GET /health"],
		})
		expect(chips.map((c) => [c.label, c.negated])).toEqual([
			["Root Span", true],
			["Service", false],
		])
	})

	it("names the param each chip clears", () => {
		const chips = traceFilterChips({ excludedNamespaces: ["internal"] })
		expect(chips).toEqual([
			{ param: "excludedNamespaces", label: "Namespace", values: ["internal"], negated: true },
		])
	})

	it("ignores params present but empty", () => {
		expect(traceFilterChips({ services: [], excludedServices: [] })).toEqual([])
	})

	it("keeps sidebar order within each polarity", () => {
		const chips = traceFilterChips({
			httpMethods: ["GET"],
			services: ["api"],
			deploymentEnvs: ["prod"],
		})
		expect(chips.map((c) => c.label)).toEqual(["Environment", "Service", "HTTP Method"])
	})
})
