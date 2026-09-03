import { describe, expect, it } from "vitest"
import { agentSessionsFilterInputs, hasAgentSessionsFilters } from "./agent-sessions-filter-inputs"

const window = { startTime: "2026-08-19 09:00:00", endTime: "2026-08-19 11:00:00" }

describe("agentSessionsFilterInputs", () => {
	it("sends only the window when nothing is set", () => {
		expect(agentSessionsFilterInputs({}, window)).toEqual(window)
	})

	it("renames the URL keys and converts seconds to milliseconds", () => {
		expect(
			agentSessionsFilterInputs(
				{
					vendors: ["eve"],
					services: [],
					models: ["gpt-5.5"],
					q: "  wrun_01 ",
					hasErrors: true,
					grouped: true,
					durationMin: 30,
					durationMax: 600,
					costMin: 0.1,
					tokensMax: 200_000,
					llmCallsMin: 1,
					toolCallsMax: 9,
					sortBy: "cost",
					sortDir: "desc",
				},
				window,
			),
		).toEqual({
			...window,
			vendorIds: ["eve"],
			models: ["gpt-5.5"],
			search: "wrun_01",
			hasErrors: true,
			excludeTraceSessions: true,
			durationMinMs: 30_000,
			durationMaxMs: 600_000,
			costMin: 0.1,
			tokensMax: 200_000,
			llmCallsMin: 1,
			toolCallsMax: 9,
			sortBy: "cost",
			sortDir: "desc",
		})
	})

	it("sorts by the menu row the URL resolves to, never by a pair the menu lacks", () => {
		expect(agentSessionsFilterInputs({ sortBy: "startTime", sortDir: "desc" }, window)).toEqual(window)
		expect(agentSessionsFilterInputs({ sortBy: "cost", sortDir: "asc" }, window)).toEqual(window)
		expect(agentSessionsFilterInputs({ sortBy: "startTime", sortDir: "asc" }, window)).toEqual({
			...window,
			sortBy: "startTime",
			sortDir: "asc",
		})
	})

	it("treats false toggles, empty arrays and blank search as no filter", () => {
		expect(hasAgentSessionsFilters({})).toBe(false)
		expect(hasAgentSessionsFilters({ hasErrors: false, services: [], sortBy: "cost" })).toBe(false)
		expect(hasAgentSessionsFilters({ q: "a" })).toBe(true)
		expect(hasAgentSessionsFilters({ durationMin: 0 })).toBe(true)
		const inputs = agentSessionsFilterInputs({ hasErrors: false, grouped: false, q: "  " }, window)
		expect(inputs).toEqual(window)
	})
})
