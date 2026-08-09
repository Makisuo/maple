import { InternalRpcToolNotFoundError, type InternalMcpToolDescriptor } from "@maple/domain/internal-rpc"
import { Context, Effect, Layer } from "effect"
import { executeRegisteredMcpToolUnscoped, mapleToolCatalog, toInputSchema } from "./tools/registry"
import type { McpToolResult } from "./tools/types"
import type { McpToolRuntimeRequirements } from "./tools/runtime-requirements"
import { CurrentMcpTenant } from "./lib/query-warehouse"
import type { TenantContext } from "@/services/auth/tenant-context"

/**
 * Built on first use, not at module scope.
 *
 * `apps/api/src/chat/tools.ts` imports this module and is itself reachable from the tool registry's
 * own import graph (registry -> a tool -> issue-hub/ai-triage-enqueue -> chat/session -> chat/tools
 * -> here). Computing the descriptors eagerly meant that whichever module the bundler happened to
 * evaluate first could observe the tool catalog as `undefined`. Deferring removes the
 * ordering dependency entirely rather than papering over one edge of the cycle.
 */
let toolDescriptors: ReadonlyArray<InternalMcpToolDescriptor> | undefined

const listToolDescriptors = (): ReadonlyArray<InternalMcpToolDescriptor> =>
	(toolDescriptors ??= mapleToolCatalog.map((definition) => ({
		name: definition.name,
		description: definition.description,
		inputSchema: toInputSchema(definition.schema),
	})))

export const listMcpTools = Effect.sync(listToolDescriptors)

/** Raw dispatcher. Executable handlers stay private so callers cannot omit the request tenant. */
const callMcpToolUnscoped = Effect.fn("McpToolDispatcher.call")(function* (name: string, input: unknown) {
	return yield* executeRegisteredMcpToolUnscoped(name, input).pipe(
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
		Effect.annotateLogs({ tool: name }),
	)
})

export interface McpToolExecutorShape {
	readonly execute: (
		tenant: TenantContext,
		name: string,
		input: unknown,
	) => Effect.Effect<McpToolResult, InternalRpcToolNotFoundError>
}

/**
 * Closed execution boundary for every MCP surface.
 *
 * The layer captures the finite application-service context once. Each call
 * must then supply its authenticated tenant explicitly, so no transport can
 * accidentally execute a raw handler without CurrentMcpTenant.
 */
export class McpToolExecutor extends Context.Service<McpToolExecutor, McpToolExecutorShape>()(
	"@maple/api/mcp/McpToolExecutor",
	{
		make: Effect.gen(function* () {
			const runtimeServices = yield* Effect.context<McpToolRuntimeRequirements>()

			const execute = Effect.fn("McpToolExecutor.execute")(function* (
				tenant: TenantContext,
				name: string,
				input: unknown,
			) {
				return yield* callMcpToolUnscoped(name, input).pipe(
					Effect.provideService(CurrentMcpTenant, tenant),
					Effect.provide(runtimeServices),
				)
			})

			return { execute }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
