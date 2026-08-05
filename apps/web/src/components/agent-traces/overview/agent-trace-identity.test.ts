import { describe, expect, it } from "vitest"
import { isTruncated, agentTraceIdentity, agentTraceMetaLine, agentTraceModels } from "./agent-trace-identity"
import { formatCost, formatAgentTraceDuration, formatTokens } from "./agent-traces-format"
import type { AgentTraceRow } from "./agent-trace-row"

const base: AgentTraceRow = {
	agentTraceId: "jny_5Hb9Wt2xQe",
	title: "Why did the March payout batch fail for 12 merchants?",
	startTime: "2026-08-04 14:06:22",
	endTime: "2026-08-04 14:09:34",
	durationMs: 192_000,
	turnCount: 14,
	toolCallCount: 9,
	toolErrorCount: 0,
	errorCount: 0,
	spanCount: 120,
	traceCount: 3,
	inputTokens: 18_000,
	outputTokens: 3500,
	totalTokens: 21_500,
	cachedInputTokens: 0,
	reasoningTokens: 0,
	cost: 0.412,
	models: ["claude-opus-5", "gpt-5.6", "gemini-3-flash"],
	requestedModels: ["claude-opus-5"],
	providers: ["anthropic"],
	agents: ["payouts-agent", "ledger-analyst", "sre-analyst"],
	workflowName: "payout-reconciliation",
	finishReasons: ["stop"],
	serviceName: "payments",
	status: "ok",
	contentRedacted: false,
	contentInEvents: false,
}

const row = (patch: Partial<AgentTraceRow>): AgentTraceRow => ({ ...base, ...patch })

// The ladder is the whole reason a redacted list stays readable: every rung is a
// real name, so no row can render empty.
describe("agentTraceIdentity", () => {
	it("leads with the first user message when content was captured", () => {
		expect(agentTraceIdentity(base)).toMatchObject({
			label: base.title,
			kind: "message",
		})
	})

	it("falls back to the workflow name when content is stripped", () => {
		expect(agentTraceIdentity(row({ title: null }))).toMatchObject({
			label: "payout-reconciliation",
			kind: "workflow",
			kindLabel: "workflow",
		})
	})

	it("falls back to the agent when no workflow was reported", () => {
		expect(agentTraceIdentity(row({ title: null, workflowName: "" }))).toMatchObject({
			label: "payouts-agent",
			kind: "agent",
		})
	})

	it("falls back to the agent trace id on bare provider spans", () => {
		expect(agentTraceIdentity(row({ title: null, workflowName: "", agents: [] }))).toMatchObject({
			label: "jny_5Hb9Wt2xQe",
			kind: "agentTrace",
		})
	})

	it("treats a blank title as no title rather than an empty row", () => {
		expect(agentTraceIdentity(row({ title: "   " })).kind).toBe("workflow")
	})
})

describe("agentTraceMetaLine", () => {
	const meta = (agentTrace: AgentTraceRow, showRedacted = true) =>
		agentTraceMetaLine(agentTrace, agentTraceIdentity(agentTrace), agentTraceModels(agentTrace), { showRedacted })

	it("leads with the owning agent and counts the rest", () => {
		expect(meta(base)).toContain("payouts-agent · 3 agents")
	})

	it("names the model the agent trace led with, and how many others it used", () => {
		expect(meta(base)).toContain("claude-opus-5 +2")
		expect(meta(row({ models: ["claude-opus-5"] }))).toContain("claude-opus-5 ·")
	})

	it("does not repeat the title when the title is already the agent name", () => {
		const line = meta(row({ title: null, workflowName: "", agents: ["ai-triage"] }))
		expect(line).not.toContain("ai-triage")
	})

	it("says so when no agent was reported at all", () => {
		expect(meta(row({ title: null, workflowName: "", agents: [] }))).toContain("no agent reported")
	})

	it("names the redaction only while some rows are unredacted", () => {
		expect(meta(row({ contentRedacted: true }))).toContain("content redacted")
		expect(meta(row({ contentRedacted: true }), false)).not.toContain("content redacted")
	})

	// The trailing lane carries "when" now, and a clock in both places is one more
	// figure competing for attention in a line meant to read as a single phrase.
	it("carries no timestamp — the row's time lane owns that", () => {
		expect(meta(base)).not.toContain(":")
		expect(meta(row({ status: "running" }))).not.toContain("running now")
	})

	it("surfaces the error count on a failed agent trace", () => {
		expect(meta(row({ status: "error", errorCount: 2 }))).toContain("2 errors")
	})

	it("says 'no tools' rather than '0 tools'", () => {
		expect(meta(row({ toolCallCount: 0 }))).toContain("no tools")
	})
})

describe("agentTraceModels", () => {
	it("leads with the first served model and counts the rest", () => {
		expect(agentTraceModels(base)).toMatchObject({
			primary: "claude-opus-5",
			overflow: 2,
		})
	})

	it("does not flag divergence when the requested model is one of the served ones", () => {
		expect(agentTraceModels(base).diverged).toBe(false)
	})

	it("flags divergence when a router served something else", () => {
		expect(
			agentTraceModels(row({ models: ["gpt-5.6"], requestedModels: ["gpt-5.6-preview"] })).diverged,
		).toBe(true)
	})
})

describe("isTruncated", () => {
	it("is the `length` finish reason — a silent failure that reads as a finished answer", () => {
		expect(isTruncated(row({ finishReasons: ["length"] }))).toBe(true)
		expect(isTruncated(row({ finishReasons: ["stop", "tool_calls"] }))).toBe(false)
	})
})

describe("formatters", () => {
	it("never renders an unknown cost as $0.00", () => {
		expect(formatCost(null)).toBeNull()
		expect(formatCost(0)).toBe("$0.000")
		expect(formatCost(0.031)).toBe("$0.031")
		expect(formatCost(2.938)).toBe("$2.94")
	})

	it("keeps the token column narrow and comparable", () => {
		expect(formatTokens(900)).toBe("900")
		expect(formatTokens(12_400)).toBe("12.4k")
		expect(formatTokens(214_000)).toBe("214k")
		expect(formatTokens(1_680_000)).toBe("1.7M")
	})

	it("pads seconds inside a minute so the time column stays rectangular", () => {
		expect(formatAgentTraceDuration(8200)).toBe("8.2s")
		expect(formatAgentTraceDuration(41_000)).toBe("41s")
		expect(formatAgentTraceDuration(64_000)).toBe("1m 04s")
		expect(formatAgentTraceDuration(192_000)).toBe("3m 12s")
	})
})
