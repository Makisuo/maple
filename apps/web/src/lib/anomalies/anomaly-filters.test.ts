import { describe, expect, it } from "vitest"

import { anomalyFilterChips, hasAnomalyFilters, matchesAnomalyFilters } from "./anomaly-filters"

const incident = {
	severity: "critical" as const,
	signalType: "error_rate" as const,
	serviceName: "api",
	deploymentEnv: "production",
}

describe("matchesAnomalyFilters", () => {
	it("matches everything when nothing is set", () => {
		expect(matchesAnomalyFilters(incident, {})).toBe(true)
	})

	it("drops an incident whose value is excluded", () => {
		expect(matchesAnomalyFilters(incident, { excludedServices: ["api"] })).toBe(false)
		expect(matchesAnomalyFilters(incident, { excludedServices: ["worker"] })).toBe(true)
	})

	it("applies every dimension's exclusion", () => {
		expect(matchesAnomalyFilters(incident, { excludedSeverity: ["critical"] })).toBe(false)
		expect(matchesAnomalyFilters(incident, { excludedSignals: ["error_rate"] })).toBe(false)
		expect(matchesAnomalyFilters(incident, { excludedEnvs: ["production"] })).toBe(false)
	})

	it("lets an exclusion override an inclusion on the same dimension", () => {
		// The sidebar keeps the two mutually exclusive, but a hand-edited URL can carry both and
		// must not resolve to "included".
		const filters = { services: ["api"], excludedServices: ["api"] }
		expect(matchesAnomalyFilters(incident, filters)).toBe(false)
	})

	it("treats an empty array as no filter", () => {
		expect(matchesAnomalyFilters(incident, { services: [], excludedServices: [] })).toBe(true)
	})
})

describe("hasAnomalyFilters", () => {
	it("ignores empty arrays", () => {
		expect(hasAnomalyFilters({ services: [] })).toBe(false)
		expect(hasAnomalyFilters({ excludedServices: ["api"] })).toBe(true)
	})
})

describe("anomalyFilterChips", () => {
	it("puts exclusions ahead of inclusions", () => {
		const chips = anomalyFilterChips({ services: ["api"], excludedEnvs: ["staging"] })
		expect(chips.map((c) => [c.label, c.negated])).toEqual([
			["Environment", true],
			["Service", false],
		])
	})
})
