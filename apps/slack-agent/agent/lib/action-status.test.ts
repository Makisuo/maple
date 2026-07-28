import { describe, expect, test } from "bun:test"
import { describeActionsFriendly, truncateTypingStatus, type ActionRequestLike } from "./action-status.js"

const toolCall = (toolName: string): ActionRequestLike => ({ kind: "tool-call", toolName })

/** Collects every distinct phrase a pool can emit by sweeping the random space. */
const sweepPhrases = (actions: readonly ActionRequestLike[]): Set<string> => {
	const phrases = new Set<string>()
	for (let i = 0; i < 200; i++) phrases.add(describeActionsFriendly(actions, () => i / 200))
	return phrases
}

describe("describeActionsFriendly", () => {
	test("never echoes the raw tool name for known maple tools", () => {
		for (const name of ["maple__list_services", "maple__search_traces", "maple__run_sql"]) {
			for (const phrase of sweepPhrases([toolCall(name)])) {
				expect(phrase).not.toContain("__")
				expect(phrase).not.toContain(name)
			}
		}
	})

	test("picks from a multi-phrase pool at random", () => {
		const phrases = sweepPhrases([toolCall("maple__list_services")])
		expect(phrases.size).toBeGreaterThanOrEqual(15)
	})

	test("is deterministic under an injected random", () => {
		const action = [toolCall("maple__search_logs")]
		expect(describeActionsFriendly(action, () => 0.5)).toBe(describeActionsFriendly(action, () => 0.5))
	})

	test("random() === 1 (or above) still lands on a real phrase", () => {
		expect(describeActionsFriendly([toolCall("bash")], () => 1)).not.toBe("")
	})

	test("every phrase fits Slack's 50-char typing budget, batch suffix included", () => {
		const tools = [
			"bash",
			"glob",
			"grep",
			"read_file",
			"write_file",
			"web_search",
			"web_fetch",
			"render_chart",
			"maple__list_services",
			"maple__search_traces",
			"maple__search_logs",
			"maple__find_errors",
			"maple__list_dashboards",
			"maple__list_alert_rules",
			"maple__list_metrics",
			"maple__run_sql",
			"maple__search_source_code",
			"maple__search_sessions",
			"maple__register_agent",
			"totally_unknown_tool",
		]
		for (const name of tools) {
			for (const phrase of sweepPhrases([toolCall(name), toolCall(name), toolCall(name)])) {
				expect(phrase.length).toBeLessThanOrEqual(50)
				expect(phrase.endsWith("+2 more")).toBe(true)
			}
		}
	})

	test("keyword fallback covers unlisted maple tools by topic", () => {
		for (const phrase of sweepPhrases([toolCall("maple__get_trace_flamegraph")])) {
			// Lands in the traces pool, not the generic one.
			expect(phrase).not.toBe("Working on it…")
		}
	})

	test("subagent and remote-agent calls use the delegation pool", () => {
		const phrases = sweepPhrases([{ kind: "subagent-call", subagentName: "investigator" }])
		expect(phrases.size).toBeGreaterThanOrEqual(15)
		for (const phrase of phrases) expect(phrase).not.toContain("investigator")
	})

	test("empty batch falls back to a working indicator", () => {
		expect(describeActionsFriendly([])).toBe("Working…")
	})
})

describe("truncateTypingStatus", () => {
	test("passes short text through and caps long text at 50", () => {
		expect(truncateTypingStatus("short")).toBe("short")
		const long = truncateTypingStatus("x".repeat(120))
		expect(long.length).toBe(50)
		expect(long.endsWith("…")).toBe(true)
	})
})
