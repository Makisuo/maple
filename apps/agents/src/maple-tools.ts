import type { AgentTool, HandlerContext } from "@electric-ax/agents-runtime"
import { getMapleAgentSetup } from "@maple/api/agent"
import { requiresApproval } from "@maple/ai"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { Type } from "@mariozechner/pi-ai"

interface MapleToolsOptions {
	readonly env: Record<string, unknown>
	readonly orgId: string
}

const toToolParameters = (jsonSchema: Record<string, unknown>) => {
	const unsafe = (Type as unknown as { Unsafe?: (schema: unknown) => unknown }).Unsafe
	return (
		unsafe ? unsafe(jsonSchema) : Type.Object({}, { additionalProperties: true })
	) as AgentTool["parameters"]
}

const createInternalToolRequest = (orgId: string, internalServiceToken: string) =>
	new Request("https://maple-agents.internal/mcp", {
		headers: {
			Authorization: `Bearer maple_svc_${internalServiceToken}`,
			"X-Org-Id": orgId,
		},
	})

const toolResultText = (result: { content: ReadonlyArray<{ text: string }>; isError?: boolean }): string =>
	result.content.map((entry) => entry.text).join("\n\n")

export const createMapleElectricTools = async (
	ctx: any,
	{ env, orgId }: MapleToolsOptions,
): Promise<AgentTool[]> => {
	const { runtime, mapleToolDefinitions, toInputSchema } = await getMapleAgentSetup(env, {
		database: "libsql",
	})
	const requestLayer = Layer.succeed(
		HttpServerRequest.HttpServerRequest,
		HttpServerRequest.fromWeb(createInternalToolRequest(orgId, String(env.INTERNAL_SERVICE_TOKEN ?? ""))),
	)

	return mapleToolDefinitions.map((definition) => ({
		name: definition.name,
		label: definition.name.replace(/_/g, " "),
		description: definition.description,
		parameters: toToolParameters(toInputSchema(definition.schema)),
		execute: async (toolCallId, input) => {
			if (requiresApproval(definition.name)) {
				const approvalId = `${ctx.entityUrl}:${toolCallId}`
				ctx.state.approvalRequests?.insert({
					id: approvalId,
					toolCallId,
					toolName: definition.name,
					args: input,
					status: "pending",
					createdAt: Date.now(),
				})
				return {
					content: [
						{
							type: "text",
							text: `Approval required for ${definition.name}.`,
						},
					],
					details: { status: "approval_required", approvalId, toolName: definition.name },
					terminate: true,
				}
			}

			try {
				const decoded = Schema.decodeUnknownSync(definition.schema)(input)
				const result = await runtime.runPromise(
					definition.handler(decoded).pipe(Effect.provide(requestLayer)),
				)
				return {
					content: [{ type: "text", text: toolResultText(result) }],
					details: result,
				}
			} catch (error) {
				const message = Schema.isSchemaError(error)
					? `Invalid parameters: ${String(error)}`
					: error instanceof Error
						? error.message
						: String(error)
				throw new Error(message)
			}
		},
	}))
}

export const executeApprovedMapleTool = async (
	env: Record<string, unknown>,
	orgId: string,
	toolName: string,
	args: unknown,
): Promise<string> => {
	const { runtime, mapleToolDefinitions } = await getMapleAgentSetup(env, { database: "libsql" })
	const definition = mapleToolDefinitions.find((tool) => tool.name === toolName)
	if (!definition) throw new Error(`Unknown Maple tool "${toolName}"`)

	const requestLayer = Layer.succeed(
		HttpServerRequest.HttpServerRequest,
		HttpServerRequest.fromWeb(createInternalToolRequest(orgId, String(env.INTERNAL_SERVICE_TOKEN ?? ""))),
	)
	const decoded = Schema.decodeUnknownSync(definition.schema)(args)
	const result = await runtime.runPromise(definition.handler(decoded).pipe(Effect.provide(requestLayer)))
	return toolResultText(result)
}
