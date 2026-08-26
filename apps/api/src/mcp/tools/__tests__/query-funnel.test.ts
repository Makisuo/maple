import { describe, expect, it } from "@effect/vitest"
import { Context, Effect, Option, Schema } from "effect"
import { WarehouseExecutor, productEventsFunnel } from "@maple/query-engine/observability"
import { CH } from "@maple/query-engine"
import type { McpToolRequirements } from "@/mcp/tools/runtime-requirements"
import type { McpToolRegistrar, McpToolResult } from "@/mcp/tools/types"
import { registerQueryFunnelTool } from "@/mcp/tools/query-funnel"
import { registerListProductEventsTool } from "@/mcp/tools/list-product-events"
import { mapleToolCatalog, toInputSchema } from "@/mcp/tools/registry"
import { compiledQueryOf } from "@maple/query-engine/execution"

// Capture the handler the tool registers so its validation paths can be driven
// directly. Those return before any service is read, so an empty context is
// enough — the same trick `dispatcher.test.ts` uses.
type ToolInput = Record<string, string | number | undefined>

const captureTool = (register: (server: McpToolRegistrar) => void) => {
	let captured:
		| {
				name: string
				schema: Schema.Top
				handler: (params: ToolInput) => Effect.Effect<McpToolResult, unknown, unknown>
		  }
		| undefined
	register({
		tool: (name, _description, schema, handler) => {
			// SAFETY: the tests below pass inputs shaped by each tool's own Struct;
			// the registrar erases the parameter type, so it is re-widened here.
			captured = { name, schema, handler: (params) => handler(params as never) }
		},
	})
	if (!captured) throw new Error("tool did not register")
	return captured
}

const run = (effect: Effect.Effect<McpToolResult, unknown, unknown>) =>
	Effect.runPromise(
		(effect as Effect.Effect<McpToolResult, unknown, McpToolRequirements>).pipe(
			Effect.provide(Context.empty() as Context.Context<McpToolRequirements>),
		),
	)

const text = (result: McpToolResult) => result.content.map((c) => ("text" in c ? c.text : "")).join("\n")

describe("query_funnel / list_product_events registration", () => {
	it("both tools are in the catalog with object input schemas", () => {
		for (const name of ["query_funnel", "list_product_events"]) {
			const definition = mapleToolCatalog.find((d) => d.name === name)
			expect(definition, name).toBeDefined()
			expect(toInputSchema(definition!.schema).type).toBe("object")
		}
	})

	it("query_funnel requires steps_json and nothing else", () => {
		const definition = mapleToolCatalog.find((d) => d.name === "query_funnel")!
		expect(toInputSchema(definition.schema).required).toEqual(["steps_json"])
	})
})

describe("query_funnel validation", () => {
	const tool = captureTool(registerQueryFunnelTool)

	it("rejects malformed steps_json with the example", async () => {
		const result = await run(tool.handler({ steps_json: "not json" }))
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("Invalid steps_json")
		expect(text(result)).toContain('"kind":"page"')
	})

	it("rejects a step of an unknown kind", async () => {
		const result = await run(
			tool.handler({ steps_json: JSON.stringify([{ kind: "click", target: "#buy" }]) }),
		)
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("Invalid steps_json")
	})

	it("rejects an empty step list", async () => {
		const result = await run(tool.handler({ steps_json: "[]" }))
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("at least one step")
	})

	it("rejects a session step past step 1 before touching the warehouse", async () => {
		const result = await run(
			tool.handler({
				steps_json: JSON.stringify([
					{ kind: "event", eventName: "signup_completed" },
					{ kind: "session", dimension: "utmSource", value: "twitter" },
				]),
			}),
		)
		expect(result.isError).toBe(true)
		expect(text(result)).toContain("only valid as step 1")
	})

	it("rejects an unknown key_by and a non-positive window", async () => {
		const steps = JSON.stringify([{ kind: "event", eventName: "x" }])
		const keyBy = await run(tool.handler({ steps_json: steps, key_by: "account" }))
		expect(keyBy.isError).toBe(true)
		expect(text(keyBy)).toContain("key_by must be one of")

		const window = await run(tool.handler({ steps_json: steps, window_seconds: 0 }))
		expect(window.isError).toBe(true)
		expect(text(window)).toContain("window_seconds")
	})

	it("rejects a breakdown_by outside the vocabulary but accepts attribute:<key>", async () => {
		const steps = JSON.stringify([{ kind: "event", eventName: "x" }])
		const bad = await run(tool.handler({ steps_json: steps, breakdown_by: "plan" }))
		expect(bad.isError).toBe(true)
		expect(text(bad)).toContain("breakdown_by must be one of")
		// `attribute:plan` passes validation and proceeds to the tenant lookup,
		// which the empty context cannot satisfy — that failure is the proof it
		// got past the vocabulary check.
		await expect(
			run(tool.handler({ steps_json: steps, breakdown_by: "attribute:plan" })),
		).rejects.toThrow()
	})
})

describe("productEventsFunnel (observability helper)", () => {
	const rows: ReadonlyArray<{ step: number; count: number }> = [
		{ step: 1, count: 100 },
		{ step: 2, count: 40 },
	]
	const compiledSql: string[] = []
	const executor = Context.make(WarehouseExecutor, {
		orgId: "org_test",
		query: () => Effect.succeed({ data: [] }),
		compiledQuery: <T>(compiled: { readonly sql: string }) => {
			compiledSql.push(compiledQueryOf(compiled).sql)
			// SAFETY: the stub answers every compiled query with funnel rows; the
			// only query these tests compile is the funnel, whose row type is `T`.
			return Effect.succeed(rows as ReadonlyArray<T>)
		},
		compiledQueryFirst: () => Effect.succeed(Option.none()),
	})

	it.effect("compiles a definition and returns the executor's rows", () =>
		Effect.gen(function* () {
			const result = yield* productEventsFunnel({
				startTime: "2026-08-10 00:00:00",
				endTime: "2026-08-17 00:00:00",
				steps: [
					{ kind: "page", pagePath: "/pricing" },
					{ kind: "event", eventName: "signup_completed" },
				],
				keyBy: "person",
				windowSeconds: 86400,
			}).pipe(Effect.provide(executor))
			expect(result).toEqual(rows)
			expect(compiledSql.at(-1)).toContain("windowFunnel")
		}),
	)

	it.effect("surfaces a builder rejection as ProductEventsFunnelError, not a defect", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				productEventsFunnel({
					startTime: "2026-08-10 00:00:00",
					endTime: "2026-08-17 00:00:00",
					steps: [
						{ kind: "event", eventName: "signup_completed" },
						{ kind: "session", dimension: "country", value: "DE" },
					],
					keyBy: "person",
					windowSeconds: 86400,
				}).pipe(Effect.provide(executor)),
			)
			expect(exit._tag).toBe("Failure")
			const failed = yield* Effect.flip(
				productEventsFunnel({
					startTime: "2026-08-10 00:00:00",
					endTime: "2026-08-17 00:00:00",
					steps: [],
					keyBy: "person",
					windowSeconds: 86400,
				}).pipe(Effect.provide(executor)),
			)
			expect(failed).toBeInstanceOf(CH.ProductEventsFunnelError)
			expect((failed as CH.ProductEventsFunnelError).reason).toBe("NoSteps")
		}),
	)
})

describe("list_product_events registration shape", () => {
	it("registers with only optional parameters", () => {
		const tool = captureTool(registerListProductEventsTool)
		expect(tool.name).toBe("list_product_events")
		expect(toInputSchema(tool.schema).required ?? []).toEqual([])
	})
})
