import { describe, expect, it } from "vitest"
import { baseToolName, filterMcpTools, splitToolResult } from "./mcp.ts"

/**
 * `apps/api`'s `createDualContent` emits two text entries per tool result: the
 * human report, then the `__maple_ui` payload the web renders as a table/chart.
 * Joining them into one string is what previously left the browser with an
 * unparseable blob and the model with raw UI JSON inlined in its report.
 */
describe("splitToolResult", () => {
	it("separates the report text from the UI payload", () => {
		expect(
			splitToolResult({
				content: [
					{ type: "text", text: "## Services\n2 services" },
					{ type: "text", text: JSON.stringify({ __maple_ui: true, kind: "service_table", rows: [] }) },
				],
			}),
		).toEqual({
			text: "## Services\n2 services",
			ui: { __maple_ui: true, kind: "service_table", rows: [] },
		})
	})

	it("omits `ui` when the tool returns plain text only", () => {
		expect(splitToolResult({ content: [{ type: "text", text: "no data" }] })).toEqual({ text: "no data" })
	})

	it("keeps ordinary JSON output as report text", () => {
		const text = JSON.stringify({ rows: [1, 2] })
		expect(splitToolResult({ content: [{ type: "text", text }] })).toEqual({ text })
	})

	it("joins multiple report entries and never returns an empty report", () => {
		expect(splitToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toEqual({
			text: "a\n\nb",
		})
		expect(splitToolResult({ content: [] }).text).toBe("(MCP tool returned no content)")
	})
})

describe("baseToolName", () => {
	it("strips the mcp prefix and leaves unprefixed names alone", () => {
		expect(baseToolName("mcp__maple__list_services")).toBe("list_services")
		expect(baseToolName("submit_diagnosis")).toBe("submit_diagnosis")
	})
})

describe("filterMcpTools", () => {
	it("filters on the unprefixed name", () => {
		const tools = [{ name: "mcp__maple__list_services" }, { name: "mcp__maple__create_dashboard" }]
		expect(filterMcpTools(tools, new Set(["list_services"]))).toEqual([{ name: "mcp__maple__list_services" }])
	})
})
