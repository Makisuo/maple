/**
 * Bridge between Maple's MCP tool registry (Effect-Schema + Effect handlers)
 * and Electric Agents' `AgentTool` shape (TypeBox parameters + plain async
 * execute).
 *
 * Each Maple tool definition:
 *   { name, description, schema: Schema<unknown, never>, handler: (params) => Effect<McpToolResult, McpToolError, R> }
 *
 * Maps to an Electric Agents tool:
 *   { name, label, description, parameters: TSchema, execute(toolCallId, params) => Promise<{content, details}> }
 *
 * The handler effect requires `HttpServerRequest` to identify the calling
 * org. We synthesise an internal-service request bearing the org id +
 * `INTERNAL_SERVICE_TOKEN` so the Maple API services can authorise it the
 * same way a real authed request would.
 */
import { Type, type TSchema } from "@sinclair/typebox"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { getMapleAgentSetup } from "@maple/api/agent"
import type { AgentTool } from "@electric-ax/agents-runtime"

interface MapleToolsContext {
	orgId: string
	env: Record<string, unknown>
}

const createInternalToolRequest = (
	orgId: string,
	internalServiceToken: string,
): Request =>
	new Request("https://maple-chat-agent.internal/mcp", {
		headers: {
			Authorization: `Bearer maple_svc_${internalServiceToken}`,
			"X-Org-Id": orgId,
		},
	})

// Turn a human-readable tool name into the "Title Case" label some UIs use.
const toLabel = (name: string): string =>
	name
		.split("_")
		.map((segment) =>
			segment.length === 0 ? segment : segment[0]!.toUpperCase() + segment.slice(1),
		)
		.join(" ")

export async function createMapleAgentTools({
	orgId,
	env,
}: MapleToolsContext): Promise<AgentTool[]> {
	const { runtime, mapleToolDefinitions, toInputSchema } =
		await getMapleAgentSetup(env)

	const internalServiceToken = String(env.INTERNAL_SERVICE_TOKEN ?? "")
	const requestLayer = Layer.succeed(
		HttpServerRequest.HttpServerRequest,
		HttpServerRequest.fromWeb(
			createInternalToolRequest(orgId, internalServiceToken),
		),
	)

	return mapleToolDefinitions.map((definition): AgentTool => {
		// `toInputSchema` produces a JSON-schema document; wrap as TypeBox
		// `Type.Unsafe` so the agents-runtime accepts it without forcing us
		// to mirror every Effect schema in TypeBox.
		const jsonSchema = toInputSchema(definition.schema)
		const parameters = Type.Unsafe<Record<string, unknown>>(jsonSchema)

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const decodeParams = Schema.decodeUnknownSync(definition.schema as any)

		return {
			name: definition.name,
			label: toLabel(definition.name),
			description: definition.description,
			parameters: parameters as TSchema,
			execute: async (_toolCallId, params) => {
				try {
					const decoded = decodeParams(params)
					const result = await runtime.runPromise(
						definition.handler(decoded).pipe(Effect.provide(requestLayer)),
					)
					return {
						content: result.content,
						details: undefined,
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error)
					return {
						content: [
							{ type: "text" as const, text: `Tool ${definition.name} failed: ${message}` },
						],
						details: undefined,
					}
				}
			},
		}
	})
}
