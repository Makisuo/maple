import { describe, expect, it } from "vitest"
import { encodeKey } from "@/lib/cache-key"
import {
	hasActiveAgentTraceFilters,
	agentTracesFilterInputs,
	agentTracesSortInputs,
	type AgentTracesSearchState,
} from "./agent-traces-filter-inputs"
import { AGENT_TRACES_PAGE_SIZE } from "./use-infinite-agent-traces"

/**
 * The route's `loader` prefetches both queries and the component then reads
 * them. That only pays off if the two produce the *same* atom-family key — a
 * mismatch silently doubles the requests instead of halving the latency.
 */
describe("agentTracesFilterInputs", () => {
	const window: AgentTracesSearchState = {
		startTime: "2026-08-01 00:00:00",
		endTime: "2026-08-02 00:00:00",
	}
	const listKey = (search: AgentTracesSearchState) =>
		encodeKey({
			...agentTracesFilterInputs(search),
			...agentTracesSortInputs(search),
			limit: AGENT_TRACES_PAGE_SIZE,
			offset: 0,
		})
	const facetsKey = (search: AgentTracesSearchState) => encodeKey(agentTracesFilterInputs(search))

	it("keys identically with no search params at all (the default 24h entry)", () => {
		expect(listKey({})).toBe(listKey({ timePreset: "24h" }))
	})

	it("separates the list and facets keys, which query different shapes", () => {
		expect(listKey(window)).not.toBe(facetsKey(window))
	})

	it("changes the list key when a filter or the sort changes", () => {
		expect(listKey({ ...window, model: "claude-opus-5" })).not.toBe(listKey(window))
		expect(listKey({ ...window, status: "error" })).not.toBe(listKey(window))
		expect(listKey({ ...window, q: "payout" })).not.toBe(listKey(window))
		expect(listKey({ ...window, sort: "cost" })).not.toBe(listKey(window))
	})

	it("leaves the facets key untouched by the sort — the counts don't depend on it", () => {
		expect(facetsKey({ ...window, sort: "cost" })).toBe(facetsKey(window))
	})

	it("converts the whole-second duration params the warehouse wants in milliseconds", () => {
		expect(agentTracesFilterInputs({ ...window, durationMin: 30, durationMax: 600 })).toMatchObject({
			durationMinMs: 30_000,
			durationMaxMs: 600_000,
		})
	})

	it("passes cost, turn and token bounds through in their own units", () => {
		expect(
			agentTracesFilterInputs({
				...window,
				costMin: 1,
				turnMax: 20,
				tokenMin: 5000,
			}),
		).toMatchObject({ costMin: 1, turnMax: 20, tokenMin: 5000 })
	})

	it("leaves unset bounds undefined rather than sending 0", () => {
		const inputs = agentTracesFilterInputs(window)
		expect(inputs.durationMinMs).toBeUndefined()
		expect(inputs.costMin).toBeUndefined()
	})
})

describe("hasActiveAgentTraceFilters", () => {
	it("ignores the time range and the sort — neither is a filter", () => {
		expect(
			hasActiveAgentTraceFilters({
				timePreset: "7d",
				sort: "cost",
				sortDirection: "asc",
			}),
		).toBe(false)
	})

	it("counts an empty search string as no filter", () => {
		expect(hasActiveAgentTraceFilters({ q: "" })).toBe(false)
	})

	it("counts a zero lower bound, which is a real filter", () => {
		expect(hasActiveAgentTraceFilters({ costMin: 0 })).toBe(true)
	})

	it.each([
		["status", { status: "error" as const }],
		["agent", { agent: "payouts-agent" }],
		["hasTools", { hasTools: true }],
		["tokenMax", { tokenMax: 1000 }],
	])("counts %s", (_name, patch) => {
		expect(hasActiveAgentTraceFilters(patch)).toBe(true)
	})
})
