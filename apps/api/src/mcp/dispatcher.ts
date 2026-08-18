// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import { InternalRpcToolNotFoundError, type InternalMcpToolDescriptor } from "@maple/domain/internal-rpc"
import { Context, Effect, Layer } from "effect"
import { executeRegisteredMcpToolUnscoped, mapleToolCatalog, toInputSchema } from "./tools/registry"
import type { McpToolResult } from "./tools/types"
import type { McpToolRuntimeRequirements } from "./tools/runtime-requirements"
import { CurrentMcpTenant } from "./lib/query-warehouse"
import { recordExpectedMcpFailure } from "./expected-failures"
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
	// The tool name was a log annotation only, so per-tool attribution worked
	// solely because each handler happens to carry its own `McpTool.<name>` span
	// — every usage query had to reconstruct it with `substring(SpanName, 9)`.
	yield* Effect.annotateCurrentSpan("maple.mcp.tool", name)
	return yield* executeRegisteredMcpToolUnscoped(name, input).pipe(
		Effect.catchTag("@maple/mcp/decode-error", (error) =>
			recordExpectedMcpFailure(error, "Invalid parameters").pipe(
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
				Effect.logError("MCP tool execution failed").pipe(
					Effect.annotateLogs({
						"error.message": error.message,
						"error.type": error._tag,
						"maple.mcp.pipe": error.pipeName,
					}),
					Effect.as({
						isError: true,
						content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
					} satisfies McpToolResult),
				),
			"@maple/mcp/errors/McpTenantError": (error) =>
				Effect.logError("MCP tool execution failed").pipe(
					Effect.annotateLogs({ "error.message": error.message, "error.type": error._tag }),
					Effect.as({
						isError: true,
						content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
					} satisfies McpToolResult),
				),
			// Missing/invalid credentials are expected 401s, not failures: they are
			// recorded on the span as attributes + a Warn log (see
			// `expected-failures.ts`), never as an Error status or exception event.
			"@maple/mcp/errors/McpAuthMissingError": (error) =>
				recordExpectedMcpFailure(error, "MCP authentication failed").pipe(
					Effect.as({
						isError: true,
						content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
					} satisfies McpToolResult),
				),
			"@maple/mcp/errors/McpAuthInvalidError": (error) =>
				recordExpectedMcpFailure(error, "MCP authentication failed").pipe(
					Effect.as({
						isError: true,
						content: [{ type: "text", text: `${error._tag}: ${error.message}` }],
					} satisfies McpToolResult),
				),
			"@maple/mcp/errors/McpAuthUnavailableError": (error) =>
				Effect.logError("MCP authentication dependency failed").pipe(
					Effect.annotateLogs({ "error.message": error.message, "error.type": error._tag }),
					Effect.as({
						isError: true,
						content: [{ type: "text", text: "Authentication is temporarily unavailable." }],
					} satisfies McpToolResult),
				),
			"@maple/mcp/errors/McpInvalidTenantError": (error) =>
				Effect.logError("MCP tenant validation failed").pipe(
					Effect.annotateLogs({
						"error.message": error.message,
						"error.type": error._tag,
						"maple.mcp.field": error.field,
					}),
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
		// After the catchTags above, so a failure they converted into an in-band
		// `isError` result is still counted. Tool handlers report failure in the
		// result rather than the error channel, so span status alone never
		// reflected a failed tool call.
		Effect.tap((result) => Effect.annotateCurrentSpan("result.isError", result.isError === true)),
		Effect.annotateLogs({ "maple.mcp.tool": name }),
	)
})

/**
 * Which entry point drove this tool call.
 *
 * Four surfaces share one dispatcher, and until this existed none of them were
 * distinguishable in telemetry: the public-vs-internal traffic split had to be
 * inferred from the ratio of `tools/call` spans to executor spans. Required
 * rather than defaulted, for the same reason `tenant` is — a caller that forgets
 * it should not silently be counted as somebody else.
 */
export type McpToolSurface =
	/** The public MCP transport (`mcp/server.ts`). */
	| "mcp"
	/** The in-process AI chat agent (`chat/turn-runner.ts`). */
	| "chat"
	/** Agent workflow passes (`workflows/agent-pass.ts`). */
	| "workflow"
	/** Worker-to-worker internal RPC (`internal-rpc.ts`). */
	| "rpc"

export interface McpToolExecutorApi {
	readonly execute: (
		tenant: TenantContext,
		name: string,
		input: unknown,
		surface: McpToolSurface,
	) => Effect.Effect<McpToolResult, InternalRpcToolNotFoundError>
}

/**
 * Closed execution boundary for every MCP surface.
 *
 * The layer captures the finite application-service context once. Each call
 * must then supply its authenticated tenant explicitly, so no transport can
 * accidentally execute a raw handler without CurrentMcpTenant.
 */
export class McpToolExecutor extends Context.Service<McpToolExecutor, McpToolExecutorApi>()(
	"@maple/api/mcp/McpToolExecutor",
	{
		make: Effect.gen(function* () {
			const runtimeServices = yield* Effect.context<McpToolRuntimeRequirements>()

			const execute = Effect.fn("McpToolExecutor.execute")(function* (
				tenant: TenantContext,
				name: string,
				input: unknown,
				surface: McpToolSurface,
			) {
				yield* Effect.annotateCurrentSpan({
					"maple.mcp.tool": name,
					"maple.mcp.surface": surface,
				})
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
