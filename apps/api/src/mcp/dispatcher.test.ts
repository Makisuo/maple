import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import type { InternalRpcToolNotFoundError } from "@maple/domain/internal-rpc"
import { callMcpTool, listMcpTools } from "./dispatcher"
import { mapleToolDefinitions, toInputSchema } from "./tools/registry"

describe("MCP dispatcher", () => {
	it("publishes the same names, descriptions, and schemas used by HTTP MCP", async () => {
		const descriptors = await Effect.runPromise(listMcpTools)
		expect(descriptors).toEqual(
			mapleToolDefinitions.map((definition) => ({
				name: definition.name,
				description: definition.description,
				inputSchema: toInputSchema(definition.schema),
			})),
		)
	})

	it("returns MCP validation feedback for invalid model tool input", async () => {
		const result = await Effect.runPromise(
			callMcpTool("inspect_trace", {}) as unknown as Effect.Effect<
				{
					readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
					readonly isError?: boolean
				},
				never,
				never
			>,
		)
		expect(result.isError).toBe(true)
		expect(result.content[0]?.text).toContain("Invalid parameters")
		expect(result.content[0]?.text).toContain("inspect_trace")
	})

	it("fails unknown RPC tool names with a typed error", async () => {
		const error = await Effect.runPromise(
			Effect.flip(
				callMcpTool("not_a_maple_tool", {}) as Effect.Effect<
					never,
					InternalRpcToolNotFoundError,
					never
				>,
			),
		)
		expect(error._tag).toBe("@maple/internal-rpc/ToolNotFoundError")
		expect(error.name).toBe("not_a_maple_tool")
	})
})
