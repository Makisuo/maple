import { assert, describe, it } from "@effect/vitest"
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

		assert.deepStrictEqual(invalidSchemas, [])
	})

	it.effect("publishes the same names, descriptions, and schemas used by HTTP MCP", () =>
		Effect.gen(function* () {
			const descriptors = yield* listMcpTools
			assert.deepStrictEqual(
				descriptors,
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
		assert.deepStrictEqual(toInputSchema(Schema.Struct({})), {
			type: "object",
			properties: {},
			additionalProperties: false,
		})

		// Anything else with a non-object root has parameters an empty object
		// schema would erase, so registration fails loudly instead.
		assert.throws(() => toInputSchema(Schema.Literals(["a", "b"])), /object root/)
		assert.throws(() => toInputSchema(Schema.Array(Schema.String)), /object root/)
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
			assert.strictEqual(result.isError, true)
			assert.include(result.content[0]?.text ?? "", "Invalid parameters")
			assert.include(result.content[0]?.text ?? "", "inspect_trace")
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
			assert.strictEqual(error._tag, "@maple/internal-rpc/ToolNotFoundError")
			assert.strictEqual(error.name, "not_a_maple_tool")
		}),
	)
})
