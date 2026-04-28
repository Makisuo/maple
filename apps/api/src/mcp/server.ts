import { McpSchema, McpServer as EffectMcpServer } from "effect/unstable/ai"
import { Effect, Layer, Schema, Context } from "effect"
import { mapleToolDefinitions, toInputSchema, type MapleToolDefinition } from "./tools/registry"
import type { McpToolError, McpToolRegistrar, McpToolResult } from "./tools/types"

const toErrorMessage = (error: unknown): string => {
	if (error instanceof Error && "error" in error && (error as any).error != null) {
		const inner = (error as any).error
		return inner instanceof Error ? inner.message : String(inner)
	}
	if (error instanceof Error) return error.message
	return String(error)
}

const toCallToolResult = (result: McpToolResult): typeof McpSchema.CallToolResult.Type =>
	new McpSchema.CallToolResult({
		isError: result.isError === true ? true : undefined,
		content: result.content.map((entry) => ({
			type: "text" as const,
			text: entry.text,
		})),
	})

const toDecodeErrorMessage = (definition: MapleToolDefinition, error: unknown): string => {
	if (Schema.isSchemaError(error)) {
		return `${String(error)}. Check the "${definition.name}" tool schema for valid parameter names and types.`
	}
	return String(error)
}

export const McpToolsLive = Layer.effectDiscard(
	EffectMcpServer.McpServer.use((server) =>
		Effect.forEach(mapleToolDefinitions, (definition) =>
			server.addTool({
				tool: new McpSchema.Tool({
					name: definition.name,
					description: definition.description,
					inputSchema: toInputSchema(definition.schema),
				}),
				annotations: Context.empty(),
				handle: (payload) =>
					Effect.gen(function* () {
						const decoded = yield* Effect.try({
							try: () => Schema.decodeUnknownSync(definition.schema)(payload),
							catch: (error) => error,
						}).pipe(
							Effect.mapError((error) => {
								const errorMessage = toDecodeErrorMessage(definition, error)
								return { _tag: "@maple/mcp/decode-error" as const, errorMessage }
							}),
						)

						return yield* definition.handler(decoded).pipe(
							Effect.tap(() => Effect.logInfo("Tool completed")),
							Effect.map(toCallToolResult),
						)
					}).pipe(
						Effect.catchTag("@maple/mcp/decode-error", (error) =>
							Effect.logWarning("Invalid parameters").pipe(
								Effect.annotateLogs({ error: error.errorMessage }),
								Effect.as(
									toCallToolResult({
										isError: true,
										content: [
											{
												type: "text",
												text: `Invalid parameters: ${error.errorMessage}`,
											},
										],
									}),
								),
							),
						),
						Effect.catchTags({
							"@maple/mcp/errors/McpQueryError": (error) =>
								Effect.logError(`Tool error: ${error.message}`).pipe(
									Effect.annotateLogs({
										errorTag: error._tag,
										pipe: error.pipe,
									}),
									Effect.as(
										toCallToolResult({
											isError: true,
											content: [
												{ type: "text", text: `${error._tag}: ${error.message}` },
											],
										}),
									),
								),
							"@maple/mcp/errors/McpTenantError": (error) =>
								Effect.logError(`Tool error: ${error.message}`).pipe(
									Effect.annotateLogs({ errorTag: error._tag }),
									Effect.as(
										toCallToolResult({
											isError: true,
											content: [
												{ type: "text", text: `${error._tag}: ${error.message}` },
											],
										}),
									),
								),
							"@maple/mcp/errors/McpAuthMissingError": (error) =>
								Effect.logError(`Auth error: ${error.message}`).pipe(
									Effect.annotateLogs({ errorTag: error._tag }),
									Effect.as(
										toCallToolResult({
											isError: true,
											content: [
												{ type: "text", text: `${error._tag}: ${error.message}` },
											],
										}),
									),
								),
							"@maple/mcp/errors/McpAuthInvalidError": (error) =>
								Effect.logError(`Auth error: ${error.message}`).pipe(
									Effect.annotateLogs({ errorTag: error._tag }),
									Effect.as(
										toCallToolResult({
											isError: true,
											content: [
												{ type: "text", text: `${error._tag}: ${error.message}` },
											],
										}),
									),
								),
							"@maple/mcp/errors/McpInvalidTenantError": (error) =>
								Effect.logError(
									`Tenant validation error [${error.field}]: ${error.message}`,
								).pipe(
									Effect.annotateLogs({ errorTag: error._tag, field: error.field }),
									Effect.as(
										toCallToolResult({
											isError: true,
											content: [
												{
													type: "text",
													text: `${error._tag} (${error.field}): ${error.message}`,
												},
											],
										}),
									),
								),
						}),
						Effect.catchDefect((error) =>
							Effect.logError(`Tool defect: ${toErrorMessage(error)}`).pipe(
								Effect.as(
									toCallToolResult({
										isError: true,
										content: [{ type: "text", text: `Error: ${toErrorMessage(error)}` }],
									}),
								),
							),
						),
						Effect.annotateLogs({ tool: definition.name }),
					),
			}),
		).pipe(Effect.asVoid),
	),
)
