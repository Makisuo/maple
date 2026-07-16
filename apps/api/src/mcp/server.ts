import { McpSchema, McpServer as EffectMcpServer } from "effect/unstable/ai"
import { Context, Effect, Layer } from "effect"
import { callMcpTool, listMcpTools } from "./dispatcher"
import { CurrentMcpTenant, resolveHttpMcpTenant } from "./lib/query-warehouse"
import type { McpToolResult } from "./tools/types"

const toCallToolResult = (result: McpToolResult): typeof McpSchema.CallToolResult.Type =>
	new McpSchema.CallToolResult({
		isError: result.isError === true ? true : undefined,
		content: result.content.map((entry) => ({
			type: "text" as const,
			text: entry.text,
		})),
	})

const toBoundaryErrorResult = (error: { readonly _tag: string; readonly message: string }) =>
	toCallToolResult({
		isError: true,
		content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
	})

/** Public MCP transport backed by the same dispatcher as internal Worker RPC. */
export const McpToolsLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const server = yield* EffectMcpServer.McpServer
		const descriptors = yield* listMcpTools
		yield* Effect.forEach(descriptors, (descriptor) =>
			server.addTool({
				tool: new McpSchema.Tool({
					name: descriptor.name,
					description: descriptor.description,
					inputSchema: descriptor.inputSchema,
				}),
				annotations: Context.empty(),
				handle: (payload) =>
					resolveHttpMcpTenant.pipe(
						Effect.flatMap((tenant) =>
							callMcpTool(descriptor.name, payload).pipe(
								Effect.provideService(CurrentMcpTenant, tenant),
							),
						),
						Effect.map(toCallToolResult),
						Effect.catchTags({
							"@maple/internal-rpc/ToolNotFoundError": (error) =>
								Effect.succeed(toBoundaryErrorResult(error)),
							"@maple/mcp/errors/McpAuthMissingError": (error) =>
								Effect.succeed(toBoundaryErrorResult(error)),
							"@maple/mcp/errors/McpAuthInvalidError": (error) =>
								Effect.succeed(toBoundaryErrorResult(error)),
							"@maple/mcp/errors/McpInvalidTenantError": (error) =>
								Effect.succeed(toBoundaryErrorResult(error)),
						}),
					),
			}),
		)
	}),
)
