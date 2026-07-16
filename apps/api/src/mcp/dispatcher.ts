import { InternalRpcToolNotFoundError, type InternalMcpToolDescriptor } from "@maple/domain/internal-rpc"
import { Effect, Schema } from "effect"
import { mapleToolDefinitions, toInputSchema, type MapleToolDefinition } from "./tools/registry"
import type { McpToolResult } from "./tools/types"

class McpDecodeError extends Schema.TaggedErrorClass<McpDecodeError>()("@maple/mcp/decode-error", {
	errorMessage: Schema.String,
}) {}

const toErrorMessage = (error: unknown): string => {
	if (error instanceof Error && "error" in error && error.error != null) {
		const inner = error.error
		return inner instanceof Error ? inner.message : String(inner)
	}
	if (error instanceof Error) return error.message
	return String(error)
}

const toDecodeErrorMessage = (definition: MapleToolDefinition, error: unknown): string => {
	if (Schema.isSchemaError(error)) {
		return `${String(error)}. Check the "${definition.name}" tool schema for valid parameter names and types.`
	}
	return String(error)
}

const toolDescriptors: ReadonlyArray<InternalMcpToolDescriptor> = mapleToolDefinitions.map((definition) => ({
	name: definition.name,
	description: definition.description,
	inputSchema: toInputSchema(definition.schema),
}))

export const listMcpTools = Effect.succeed(toolDescriptors)

/** Shared tool dispatcher for public MCP-over-HTTP and internal Worker RPC. */
export const callMcpTool = Effect.fn("McpToolDispatcher.call")(function* (name: string, input: unknown) {
	const definition = mapleToolDefinitions.find((candidate) => candidate.name === name)
	if (!definition) {
		return yield* new InternalRpcToolNotFoundError({
			name,
			message: `Unknown MCP tool: ${name}`,
		})
	}

	const execute = Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({ tool: definition.name })
		const decoded = yield* Effect.try({
			try: () => Schema.decodeUnknownSync(definition.schema)(input),
			catch: (error) => error,
		}).pipe(
			Effect.mapError(
				(error) =>
					new McpDecodeError({
						errorMessage: toDecodeErrorMessage(definition, error),
					}),
			),
		)

		return yield* definition.handler(decoded).pipe(Effect.tap(() => Effect.logInfo("Tool completed")))
	})

	return yield* execute.pipe(
		Effect.catchTag("@maple/mcp/decode-error", (error) =>
			Effect.logWarning("Invalid parameters").pipe(
				Effect.annotateLogs({ error: error.errorMessage }),
				Effect.as({
					isError: true,
					content: [
						{
							type: "text" as const,
							text: `Invalid parameters: ${error.errorMessage}`,
						},
					],
				} satisfies McpToolResult),
			),
		),
		Effect.catchTags({
			"@maple/mcp/errors/McpQueryError": (error) =>
				Effect.logError(`Tool error: ${error.message}`).pipe(
					Effect.annotateLogs({ errorTag: error._tag, pipe: error.pipeName }),
					Effect.as({
						isError: true,
						content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
					} satisfies McpToolResult),
				),
			"@maple/mcp/errors/McpTenantError": (error) =>
				Effect.logError(`Tool error: ${error.message}`).pipe(
					Effect.annotateLogs({ errorTag: error._tag }),
					Effect.as({
						isError: true,
						content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
					} satisfies McpToolResult),
				),
			"@maple/mcp/errors/McpAuthMissingError": (error) =>
				Effect.logError(`Auth error: ${error.message}`).pipe(
					Effect.annotateLogs({ errorTag: error._tag }),
					Effect.as({
						isError: true,
						content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
					} satisfies McpToolResult),
				),
			"@maple/mcp/errors/McpAuthInvalidError": (error) =>
				Effect.logError(`Auth error: ${error.message}`).pipe(
					Effect.annotateLogs({ errorTag: error._tag }),
					Effect.as({
						isError: true,
						content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
					} satisfies McpToolResult),
				),
			"@maple/mcp/errors/McpInvalidTenantError": (error) =>
				Effect.logError(`Tenant validation error [${error.field}]: ${error.message}`).pipe(
					Effect.annotateLogs({ errorTag: error._tag, field: error.field }),
					Effect.as({
						isError: true,
						content: [
							{
								type: "text",
								text: `${error._tag} (${error.field}): ${error.message}`,
							},
						],
					} satisfies McpToolResult),
				),
		}),
		Effect.catchDefect((error) =>
			Effect.logError(`Tool defect: ${toErrorMessage(error)}`).pipe(
				Effect.as({
					isError: true,
					content: [{ type: "text", text: `Error: ${toErrorMessage(error)}` }],
				} satisfies McpToolResult),
			),
		),
		Effect.annotateLogs({ tool: definition.name }),
	)
})
