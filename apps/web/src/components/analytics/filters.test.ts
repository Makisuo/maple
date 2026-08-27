import { describe, expect, it } from "vitest"
import {
	activeFilterChips,
	DEFAULT_TRAFFIC,
	filtersFromSearch,
	hasActiveFilters,
	toggleTraffic,
	trafficIncludes,
} from "./filters"

describe("traffic default", () => {
	it("excludes crawlers when the URL says nothing", () => {
		expect(filtersFromSearch({}).traffic).toBe(DEFAULT_TRAFFIC)
	})

	it("lets a shared link override the default in both directions", () => {
		expect(filtersFromSearch({ traffic: "all" }).traffic).toBe("all")
		expect(filtersFromSearch({ traffic: "bots" }).traffic).toBe("bots")
	})

	it("falls back rather than trusting an unknown value off the URL", () => {
		expect(filtersFromSearch({ traffic: "spiders" }).traffic).toBe(DEFAULT_TRAFFIC)
	})

	// The default is not something you did, so it is not something to clear.
	it("is not a chip at its default, and is one otherwise", () => {
		expect(activeFilterChips(filtersFromSearch({}))).toEqual([])
		expect(hasActiveFilters(filtersFromSearch({}))).toBe(false)
		expect(activeFilterChips(filtersFromSearch({ traffic: "all" }))[0]?.label).toBe("traffic:all")
	})
})

describe("toggleTraffic", () => {
	it("reads both boxes ticked as all traffic", () => {
		expect(toggleTraffic("humans", "bots", true)).toBe("all")
		expect(toggleTraffic("bots", "humans", true)).toBe("all")
	})

	it("narrows to the one still ticked", () => {
		expect(toggleTraffic("all", "bots", false)).toBe("humans")
		expect(toggleTraffic("all", "humans", false)).toBe("bots")
	})

	// Neither population has nothing to show and no affordance to get back.
	it("widens instead of selecting nothing", () => {
		expect(toggleTraffic("humans", "humans", false)).toBe("all")
		expect(toggleTraffic("bots", "bots", false)).toBe("all")
	})

	it("treats an absent value as the default", () => {
		expect(toggleTraffic(undefined, "bots", true)).toBe("all")
		expect(trafficIncludes(undefined, "humans")).toBe(true)
		expect(trafficIncludes(undefined, "bots")).toBe(false)
	})
})
