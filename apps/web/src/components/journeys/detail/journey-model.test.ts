import { describe, expect, it } from "vitest"

import type { JourneyEventData, JourneySummaryData } from "./journey-model"
import { buildJourneyModel, buildTimelineView } from "./journey-model"

const BASE_TIME = Date.UTC(2026, 7, 5, 12, 0, 0)

/** Warehouse timestamps are `YYYY-MM-DD HH:MM:SS.mmm` in UTC, with no zone marker. */
function at(offsetMs: number): string {
	return new Date(BASE_TIME + offsetMs).toISOString().replace("T", " ").replace("Z", "")
}

function event(overrides: Partial<JourneyEventData> & { id: string }): JourneyEventData {
	return {
		kind: "message",
		timestamp: at(0),
		spanId: overrides.id,
		parentSpanId: "",
		traceId: "trace-1",
		operation: "chat",
		spanName: "chat",
		role: "assistant",
		content: null,
		contentSource: "attributes",
		durationMs: 1_000,
		model: null,
		requestedModel: null,
		provider: null,
		inputTokens: null,
		outputTokens: null,
		cachedInputTokens: null,
		reasoningTokens: null,
		cost: null,
		finishReason: null,
		agentName: null,
		workflowName: null,
		toolName: null,
		toolCallId: null,
		toolArguments: null,
		toolResult: null,
		parentEventId: null,
		status: "ok",
		statusMessage: null,
		...overrides,
	}
}

function summary(overrides: Partial<JourneySummaryData> = {}): JourneySummaryData {
	return {
		journeyId: "jny_1",
		title: "Why did the batch fail?",
		startTime: at(0),
		endTime: at(60_000),
		durationMs: 60_000,
		turnCount: 2,
		toolCallCount: 0,
		toolErrorCount: 0,
		errorCount: 0,
		spanCount: 4,
		traceCount: 1,
		inputTokens: 1_000,
		outputTokens: 200,
		totalTokens: 1_200,
		cachedInputTokens: 400,
		reasoningTokens: 50,
		cost: 0.12,
		models: ["claude-opus-5"],
		requestedModels: ["claude-opus-5"],
		providers: ["openrouter"],
		agents: ["payouts-agent"],
		workflowName: "payout-reconciliation",
		finishReasons: ["stop"],
		serviceName: "production",
		status: "ok",
		contentRedacted: false,
		contentInEvents: false,
		...overrides,
	}
}

describe("buildJourneyModel", () => {
	it("nests tool calls under the assistant message that requested them", () => {
		const model = buildJourneyModel(
			[
				event({ id: "m1", role: "user", content: "hi", timestamp: at(0) }),
				event({ id: "m2", content: "on it", timestamp: at(1_000), agentName: "payouts-agent" }),
				event({
					id: "t1",
					kind: "toolCall",
					toolName: "ledger.query",
					parentEventId: "m2",
					timestamp: at(1_200),
					durationMs: 400,
				}),
				event({
					id: "t2",
					kind: "toolCall",
					toolName: "merchants.lookup",
					parentEventId: "m2",
					timestamp: at(1_200),
					durationMs: 300,
					status: "error",
				}),
			],
			summary(),
		)

		expect(model.rows.map((row) => row.id)).toEqual(["m1", "m2"])
		const assistant = model.rows[1]
		expect(assistant.type).toBe("message")
		if (assistant.type !== "message") throw new Error("expected a message row")
		expect(assistant.toolCalls.map((call) => call.id)).toEqual(["t1", "t2"])
		expect(model.counts.toolFailures).toBe(1)
	})

	it("promotes an orphaned tool call to a top-level row rather than dropping it", () => {
		const model = buildJourneyModel(
			[
				event({ id: "m1", role: "user", content: "hi" }),
				event({
					id: "t1",
					kind: "toolCall",
					toolName: "orphan",
					parentEventId: "gone",
					timestamp: at(500),
				}),
			],
			summary(),
		)
		expect(model.rows.map((row) => row.id)).toContain("t1")
	})

	it("measures idle between turns and names user think-time", () => {
		const model = buildJourneyModel(
			[
				event({ id: "m1", content: "answer", timestamp: at(0), durationMs: 1_000 }),
				event({ id: "m2", role: "user", content: "follow up", timestamp: at(31_000) }),
			],
			summary(),
		)
		const idle = model.rows.find((row) => row.type === "idle")
		expect(idle).toBeDefined()
		expect(idle?.durationMs).toBe(30_000)
		if (idle?.type !== "idle") throw new Error("expected an idle row")
		expect(idle.reason).toBe("waiting on the user")
	})

	it("keeps a sub-threshold gap out of the timeline", () => {
		const model = buildJourneyModel(
			[
				event({ id: "m1", content: "a", timestamp: at(0), durationMs: 500 }),
				event({ id: "m2", content: "b", timestamp: at(1_000) }),
			],
			summary(),
		)
		expect(model.rows.every((row) => row.type !== "idle")).toBe(true)
	})

	it("pins the system prompt out of the timeline", () => {
		const model = buildJourneyModel(
			[
				event({
					id: "s1",
					kind: "systemPrompt",
					role: "system",
					content: "You are…",
					durationMs: null,
				}),
				event({ id: "m1", role: "user", content: "hi", timestamp: at(1_000) }),
			],
			summary(),
		)
		expect(model.systemPrompt?.id).toBe("s1")
		expect(model.rows.map((row) => row.id)).toEqual(["m1"])
	})

	it("treats an absent body as expected, not as an error", () => {
		const model = buildJourneyModel(
			[
				event({ id: "m1", role: "user", content: null, contentSource: "absent" }),
				event({ id: "m2", content: null, contentSource: "absent", timestamp: at(1_000) }),
			],
			summary({ contentRedacted: true }),
		)
		expect(model.allContentAbsent).toBe(true)
		expect(model.rows).toHaveLength(2)
	})

	it("splits input and output tokens into their cached and reasoning parts", () => {
		const model = buildJourneyModel([event({ id: "m1", content: "x" })], summary())
		expect(model.tokens).toMatchObject({
			cachedInput: 400,
			freshInput: 600,
			reasoning: 50,
			visibleOutput: 150,
		})
		expect(model.tokens.cachedShare).toBeCloseTo(0.4)
	})

	it("counts turns served by a model other than the one requested", () => {
		const model = buildJourneyModel(
			[
				event({ id: "m1", content: "x", requestedModel: "gpt-5.6", model: "gpt-5.6-preview" }),
				event({
					id: "m2",
					content: "y",
					requestedModel: "gpt-5.6",
					model: "gpt-5.6",
					timestamp: at(2_000),
				}),
			],
			summary(),
		)
		expect(model.divergentModelTurns).toBe(1)
	})

	it("does not double-count parallel tool time against the wall clock", () => {
		const model = buildJourneyModel(
			[
				event({ id: "m1", content: "x", timestamp: at(0), durationMs: 1_000 }),
				event({
					id: "t1",
					kind: "toolCall",
					parentEventId: "m1",
					timestamp: at(1_000),
					durationMs: 10_000,
				}),
				event({
					id: "t2",
					kind: "toolCall",
					parentEventId: "m1",
					timestamp: at(1_000),
					durationMs: 10_000,
				}),
			],
			summary({ durationMs: 11_000 }),
		)
		// Two 10s calls fired together occupy 10s of clock, not 20s.
		expect(model.timeTotals.tool).toBeGreaterThan(9_000)
		expect(model.timeTotals.tool).toBeLessThan(11_000)
	})

	it("labels an operation it has never seen rather than rendering it blank", () => {
		const model = buildJourneyModel(
			[event({ id: "o1", kind: "operation", operation: "retrieval", content: "docs" })],
			summary(),
		)
		const row = model.rows[0]
		if (row.type !== "structural") throw new Error("expected a structural row")
		expect(row.label).toBe("RETRIEVAL")
	})
})

describe("buildTimelineView", () => {
	const longJourney = () =>
		buildJourneyModel(
			Array.from({ length: 80 }, (_, index) =>
				event({
					id: `m${index}`,
					content: `turn ${index}`,
					timestamp: at(index * 1_000),
					durationMs: 400,
					agentName: "payouts-agent",
					status: index === 40 ? "error" : "ok",
				}),
			),
			summary({ durationMs: 80_000 }),
		)

	it("leaves a short journey uncondensed", () => {
		const model = buildJourneyModel(
			[event({ id: "m1", content: "a" }), event({ id: "m2", content: "b", timestamp: at(1_000) })],
			summary(),
		)
		const view = buildTimelineView(model, {
			filter: "all",
			query: "",
			expandedGroupIds: new Set(),
			condense: true,
		})
		expect(view.condensed).toBe(false)
		expect(view.rows).toHaveLength(2)
	})

	it("folds unremarkable runs on a long journey but never the failed turn", () => {
		const view = buildTimelineView(longJourney(), {
			filter: "all",
			query: "",
			expandedGroupIds: new Set(),
			condense: true,
		})
		expect(view.condensed).toBe(true)
		expect(view.rows.length).toBeLessThan(80)
		expect(view.rows.some((row) => row.id === "m40")).toBe(true)
		expect(view.rows.some((row) => row.type === "turnGroup")).toBe(true)
	})

	it("expands a group on demand", () => {
		const model = longJourney()
		const collapsed = buildTimelineView(model, {
			filter: "all",
			query: "",
			expandedGroupIds: new Set(),
			condense: true,
		})
		const group = collapsed.rows.find((row) => row.type === "turnGroup")
		expect(group).toBeDefined()
		const expanded = buildTimelineView(model, {
			filter: "all",
			query: "",
			expandedGroupIds: new Set([group!.id]),
			condense: true,
		})
		expect(expanded.rows.length).toBeGreaterThan(collapsed.rows.length)
	})

	it("never condenses while a filter is active", () => {
		const view = buildTimelineView(longJourney(), {
			filter: "errors",
			query: "",
			expandedGroupIds: new Set(),
			condense: true,
		})
		expect(view.condensed).toBe(false)
		expect(view.rows.map((row) => row.id)).toEqual(["m40"])
	})

	it("searches message bodies and tool names", () => {
		const model = buildJourneyModel(
			[
				event({ id: "m1", content: "reconcile the ledger" }),
				event({ id: "m2", content: "unrelated", timestamp: at(2_000) }),
				event({
					id: "t1",
					kind: "toolCall",
					toolName: "payouts.fetch_receipts",
					parentEventId: "m2",
					timestamp: at(2_100),
				}),
			],
			summary(),
		)
		const byBody = buildTimelineView(model, {
			filter: "all",
			query: "ledger",
			expandedGroupIds: new Set(),
			condense: false,
		})
		expect(byBody.rows.map((row) => row.id)).toEqual(["m1"])

		const byTool = buildTimelineView(model, {
			filter: "all",
			query: "fetch_receipts",
			expandedGroupIds: new Set(),
			condense: false,
		})
		expect(byTool.rows.map((row) => row.id)).toEqual(["m2"])
	})
})
