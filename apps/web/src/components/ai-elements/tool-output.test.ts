import { describe, expect, it } from "vitest"
import { extractStructuredData, extractOutputText } from "./tool"

const ui = { __maple_ui: true, kind: "service_table", rows: [{ name: "api" }] }
const report = "## Services\n2 services"

/**
 * The three shapes a tool result can have in a replayed conversation. Getting the
 * first one wrong is what made every tool call render as a wall of raw JSON: the
 * runtime started returning structured objects, and the reader still expected the
 * MCP envelope.
 */
describe("tool output", () => {
	describe("structured `{ text, ui }` results", () => {
		it("renders the UI payload and shows only the report as text", () => {
			expect(extractStructuredData({ text: report, ui })).toEqual(ui)
			expect(extractOutputText({ text: report, ui })).toBe(report)
		})

		it("has no UI payload when the tool returned text alone", () => {
			expect(extractStructuredData({ text: report })).toBeNull()
			expect(extractOutputText({ text: report })).toBe(report)
		})
	})

	describe("legacy string results", () => {
		it("recovers the UI payload the runtime used to concatenate onto the report", () => {
			const joined = `${report}\n\n${JSON.stringify(ui)}`
			expect(extractStructuredData(joined)).toEqual(ui)
			expect(extractOutputText(joined)).toBe(report)
		})

		it("leaves a plain string alone", () => {
			expect(extractStructuredData("no data")).toBeNull()
			expect(extractOutputText("no data")).toBe("no data")
		})
	})

	describe("legacy MCP `{ content }` results", () => {
		it("splits the content entries", () => {
			const output = {
				content: [
					{ type: "text", text: report },
					{ type: "text", text: JSON.stringify(ui) },
				],
			}
			expect(extractStructuredData(output)).toEqual(ui)
			expect(extractOutputText(output)).toBe(report)
		})
	})

	it("returns nothing for an absent result", () => {
		expect(extractStructuredData(null)).toBeNull()
		expect(extractOutputText(null)).toBeNull()
	})
})
