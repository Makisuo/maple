import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { buildMapleAgentTool } from "./maple-tools"
import type { MapleAgentSetup } from "@maple/api/agent"

// Two stand-in tool definitions:
//   - `find_errors` is not in the GATED_TOOL_NAMES list -> executes immediately
//   - `update_dashboard_widget` is gated -> the AgentTool should insert into the
//     approvals collection and terminate the agent run.
const FindErrorsInput = Schema.Struct({
	service: Schema.String,
	limit: Schema.optional(Schema.Number),
})

const UpdateWidgetInput = Schema.Struct({
	widget_id: Schema.String,
	widget_json: Schema.String,
})

const makeSetup = (): MapleAgentSetup => {
	const runtime = ManagedRuntime.make(Layer.empty)
	const toInputSchema = (schema: Schema.Top): Record<string, unknown> => ({
		type: "object",
		// Real `toInputSchema` returns a JSON schema; for the test we only
		// care that the tool's parameters carry *some* JSON schema through
		// TypeBox's `Unsafe()`. The contents don't matter for execute().
		"x-test-schema-id": schema.ast?._tag ?? "unknown",
	})
	const mapleToolDefinitions = [
		{
			name: "find_errors",
			description: "List recent errors for a service",
			schema: FindErrorsInput,
			handler: (input: { service: string; limit?: number }) =>
				Effect.gen(function* () {
					yield* HttpServerRequest.HttpServerRequest
					return {
						content: [
							{ type: "text" as const, text: `errors for ${input.service} (limit=${input.limit ?? 10})` },
						],
					}
				}),
		},
		{
			name: "update_dashboard_widget",
			description: "Update a dashboard widget (gated)",
			schema: UpdateWidgetInput,
			handler: (_input: { widget_id: string; widget_json: string }) =>
				Effect.succeed({ content: [{ type: "text" as const, text: "updated" }] }),
		},
	] as unknown as MapleAgentSetup["mapleToolDefinitions"]
	return { runtime, mapleToolDefinitions, toInputSchema } as unknown as MapleAgentSetup
}

const fakeRequestLayer = Layer.succeed(
	HttpServerRequest.HttpServerRequest,
	HttpServerRequest.fromWeb(
		new Request("https://test/", { headers: { "X-Org-Id": "org_test" } }),
	),
)

const makeApprovalSink = () => {
	const inserted: Array<unknown> = []
	return {
		entityUrl: "/maple_chat/test-entity",
		approvalRequests: { insert: (row: unknown) => void inserted.push(row) },
		inserted,
	}
}

describe("buildMapleAgentTool", () => {
	it("executes non-gated tools via the Effect runtime", async () => {
		const setup = makeSetup()
		const approvalSink = makeApprovalSink()
		const tool = buildMapleAgentTool(setup.mapleToolDefinitions[0], {
			setup,
			approvalSink,
			requestLayer: fakeRequestLayer,
		})

		const result = await tool.execute("call-1", { service: "checkout", limit: 5 })

		expect(result.content[0]).toEqual({ type: "text", text: "errors for checkout (limit=5)" })
		expect(result.terminate).toBeUndefined()
		expect(approvalSink.inserted).toHaveLength(0)
	})

	it("terminates and inserts an approval row for gated tools", async () => {
		const setup = makeSetup()
		const approvalSink = makeApprovalSink()
		const tool = buildMapleAgentTool(setup.mapleToolDefinitions[1], {
			setup,
			approvalSink,
			requestLayer: fakeRequestLayer,
		})

		const result = await tool.execute("call-2", {
			widget_id: "w_1",
			widget_json: '{"foo":1}',
		})

		expect(result.terminate).toBe(true)
		expect(result.details).toMatchObject({
			status: "approval_required",
			approvalId: "/maple_chat/test-entity:call-2",
			toolName: "update_dashboard_widget",
		})
		expect(approvalSink.inserted).toHaveLength(1)
		expect(approvalSink.inserted[0]).toMatchObject({
			id: "/maple_chat/test-entity:call-2",
			toolCallId: "call-2",
			toolName: "update_dashboard_widget",
			status: "pending",
			args: { widget_id: "w_1", widget_json: '{"foo":1}' },
		})
	})

	it("rejects calls whose arguments fail schema validation", async () => {
		const setup = makeSetup()
		const approvalSink = makeApprovalSink()
		const tool = buildMapleAgentTool(setup.mapleToolDefinitions[0], {
			setup,
			approvalSink,
			requestLayer: fakeRequestLayer,
		})

		await expect(tool.execute("call-3", { service: 42 })).rejects.toThrow(/Invalid parameters/)
		expect(approvalSink.inserted).toHaveLength(0)
	})

	it("converts the JSON schema via Type.Unsafe so parameters round-trip", () => {
		const setup = makeSetup()
		const approvalSink = makeApprovalSink()
		const tool = buildMapleAgentTool(setup.mapleToolDefinitions[0], {
			setup,
			approvalSink,
			requestLayer: fakeRequestLayer,
		})
		// `Type.Unsafe(jsonSchema)` returns a TSchema whose runtime shape is
		// the original JSON schema verbatim. If `Unsafe` were missing (the
		// pre-fix fallback returned `Type.Object({}, { additionalProperties: true })`),
		// the test object below wouldn't appear.
		expect(tool.parameters).toMatchObject({ type: "object" })
		expect((tool.parameters as Record<string, unknown>)["x-test-schema-id"]).toBeDefined()
	})
})
