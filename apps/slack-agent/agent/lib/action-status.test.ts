import { describe, expect, test } from "bun:test"
import { describeActions, truncateTypingStatus, type ActionRequestLike } from "./action-status.js"

const toolCall = (toolName: string): ActionRequestLike => ({ kind: "tool-call", toolName })

describe("describeActions", () => {
	test("never echoes the raw tool name for known maple tools", () => {
		for (const name of ["maple__list_services", "maple__search_traces", "maple__run_sql"]) {
			const phrase = describeActions([toolCall(name)])
			expect(phrase).not.toContain("__")
			expect(phrase).not.toContain(name)
		}
	})

	test("maps known tools to plain descriptive phrases", () => {
		expect(describeActions([toolCall("maple__search_traces")])).toBe("Searching traces…")
		expect(describeActions([toolCall("maple__run_sql")])).toBe("Running a SQL query…")
		expect(describeActions([toolCall("bash")])).toBe("Running a command…")
	})

	test("is deterministic", () => {
		const action = [toolCall("maple__search_logs")]
		expect(describeActions(action)).toBe(describeActions(action))
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
			const phrase = describeActions([toolCall(name), toolCall(name), toolCall(name)])
			expect(phrase.length).toBeLessThanOrEqual(50)
			expect(phrase.endsWith("+2 more")).toBe(true)
		}
	})

	test("keyword fallback covers unlisted maple tools by topic", () => {
		expect(describeActions([toolCall("maple__get_trace_flamegraph")])).toBe("Looking at traces…")
	})

	test("unknown maple tools stay telemetry-flavored, unknown others go generic", () => {
		expect(describeActions([toolCall("maple__register_agent")])).toBe("Querying Maple…")
		expect(describeActions([toolCall("totally_unknown_tool")])).toBe("Working…")
	})

	test("subagent and remote-agent calls use the delegation phrase", () => {
		const phrase = describeActions([{ kind: "subagent-call", subagentName: "investigator" }])
		expect(phrase).toBe("Delegating a task…")
		expect(phrase).not.toContain("investigator")
	})

	test("empty batch falls back to a working indicator", () => {
		expect(describeActions([])).toBe("Working…")
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
