import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import type { InternalRpcToolNotFoundError } from "@maple/domain/internal-rpc"
import { callMcpTool, listMcpTools } from "./dispatcher"
import { mapleToolDefinitions, toInputSchema } from "./tools/registry"

describe("MCP dispatcher", () => {
	it("publishes an object input schema for every tool", () => {
		// Strict MCP clients (the Vercel AI SDK's `tools/list` validator) drop the
		// WHOLE connection when any tool's inputSchema.type is not "object" — the
		// offending tool names are collected so a failure names them.
		const invalidSchemas = mapleToolDefinitions
			.map((definition) => ({
				name: definition.name,
				type: toInputSchema(definition.schema).type,
			}))
			.filter(({ type }) => type !== "object")

		expect(invalidSchemas).toEqual([])
	})

	it.effect("publishes the same names, descriptions, and schemas used by HTTP MCP", () =>
		Effect.gen(function* () {
			const descriptors = yield* listMcpTools
			expect(descriptors).toEqual(
				mapleToolDefinitions.map((definition) => ({
					name: definition.name,
					description: definition.description,
					inputSchema: toInputSchema(definition.schema),
				})),
			)
		}),
	)

	it("normalizes an empty Struct root and rejects a non-object root", () => {
		// Effect emits `{ anyOf: [{type:"object"},{type:"array"}] }` — no `type` —
		// for a no-parameter tool; that exact shape is normalized.
		expect(toInputSchema(Schema.Struct({}))).toEqual({
			type: "object",
			properties: {},
			additionalProperties: false,
		})

		// Anything else with a non-object root has parameters an empty object
		// schema would erase, so registration fails loudly instead.
		expect(() => toInputSchema(Schema.Literals(["a", "b"]))).toThrow(/object root/)
		expect(() => toInputSchema(Schema.Array(Schema.String))).toThrow(/object root/)
	})

	it.effect("returns MCP validation feedback for invalid model tool input", () =>
		Effect.gen(function* () {
			const result = yield* callMcpTool("inspect_trace", {}) as unknown as Effect.Effect<
				{
					readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>
					readonly isError?: boolean
				},
				never,
				never
			>
			expect(result.isError).toBe(true)
			expect(result.content[0]?.text).toContain("Invalid parameters")
			expect(result.content[0]?.text).toContain("inspect_trace")
		}),
	)

	it.effect("fails unknown RPC tool names with a typed error", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(
				callMcpTool("not_a_maple_tool", {}) as Effect.Effect<
					never,
					InternalRpcToolNotFoundError,
					never
				>,
			)
			expect(error._tag).toBe("@maple/internal-rpc/ToolNotFoundError")
			expect(error.name).toBe("not_a_maple_tool")
		}),
	)
})
