import { defineTool, type ToolDefinition } from "@flue/runtime"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import { applyApprovalGates, MUTATING_TOOL_NAMES, parseToolProposal, PROPOSAL_STATUS } from "./approval.ts"
import { runTool } from "./test-tool-context.ts"

const INPUT = v.object({ dashboard_id: v.optional(v.string()), widget_id: v.optional(v.string()) })

const fakeTool = (name: string, run: () => string = () => "real-result"): ToolDefinition =>
	defineTool({
		name,
		description: "desc",
		input: INPUT,
		output: undefined,
		run: () => run(),
	})

const call = runTool

describe("MUTATING_TOOL_NAMES", () => {
	it("covers dashboard/alert/issue mutations and excludes read tools", () => {
		expect(MUTATING_TOOL_NAMES.has("update_dashboard_widget")).toBe(true)
		expect(MUTATING_TOOL_NAMES.has("transition_error_issue")).toBe(true)
		expect(MUTATING_TOOL_NAMES.has("create_alert_rule")).toBe(true)
		expect(MUTATING_TOOL_NAMES.has("search_traces")).toBe(false)
		expect(MUTATING_TOOL_NAMES.has("find_errors")).toBe(false)
	})
})

describe("applyApprovalGates", () => {
	it("passes read-only tools through unchanged", async () => {
		const read = fakeTool("mcp__maple__search_traces")
		const [gated] = applyApprovalGates([read])
		expect(gated).toBe(read)
		expect(await call(gated!, {})).toBe("real-result")
	})

	it("replaces a mutating tool's run with a proposal marker", async () => {
		let sideEffect = false
		const mutate = fakeTool("mcp__maple__update_dashboard_widget", () => {
			sideEffect = true
			return "mutated"
		})
		const [gated] = applyApprovalGates([mutate])

		// name + input schema preserved so the model calls it identically
		expect(gated!.name).toBe("mcp__maple__update_dashboard_widget")
		expect(gated!.input).toBe(mutate.input)

		const result = await call(gated!, { dashboard_id: "d1", widget_id: "w2" })
		expect(sideEffect).toBe(false) // no mutation performed
		expect(parseToolProposal(result)).toEqual({
			status: PROPOSAL_STATUS,
			tool: "update_dashboard_widget",
			input: { dashboard_id: "d1", widget_id: "w2" },
		})
	})
})

describe("parseToolProposal", () => {
	it("reads the structured marker a gated tool returns", () => {
		expect(
			parseToolProposal({ status: PROPOSAL_STATUS, tool: "create_dashboard", input: { a: 1 } }),
		).toEqual({ status: PROPOSAL_STATUS, tool: "create_dashboard", input: { a: 1 } })
	})

	it("still reads a marker recorded as a string by an older runtime", () => {
		const legacy = JSON.stringify({ status: PROPOSAL_STATUS, tool: "create_dashboard", input: {} })
		expect(parseToolProposal(legacy)).toEqual({
			status: PROPOSAL_STATUS,
			tool: "create_dashboard",
			input: {},
		})
	})

	it("returns null for a non-proposal result", () => {
		expect(parseToolProposal("plain text")).toBeNull()
		expect(parseToolProposal({ status: "ok" })).toBeNull()
		expect(parseToolProposal(null)).toBeNull()
	})
})
