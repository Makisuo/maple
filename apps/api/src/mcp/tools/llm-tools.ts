/**
 * Maple's MCP registry, wrapped as `@maple/llm` tools.
 *
 * The streaming chat turn and investigation agents share this wrapper so tool
 * dispatch, runtime provisioning, and safe failure summaries cannot drift.
 *
 * Dynamic (`jsonSchema`) mode is the right fit for every tool here: `toInputSchema` already produces
 * the exact JSON Schema the MCP surface publishes, and `callMcpTool` does its own Effect Schema
 * decode with the tool's own error messages. Decoding twice would only give the model a second,
 * worse phrasing of the same validation failure.
 *
 * The tenant is provided per call rather than ambiently so a loop can never widen its own scope:
 * every tool executes under exactly the org the turn was started for.
 */
import { Tool, ToolFailure, type Tools } from "@maple/llm"
import { Cause, Effect } from "effect"
import { callMcpTool } from "@/mcp/dispatcher"
import { CurrentMcpTenant } from "@/mcp/lib/query-warehouse"
import { mapleToolDefinitions, toInputSchema } from "@/mcp/tools/registry"
import { truncateToolOutput } from "@/mcp/tools/tool-output"
import type { TenantContext } from "@/services/auth/tenant-context"

/**
 * Re-pin the service requirements of an MCP tool handler.
 *
 * `MapleToolDefinition.handler` types its requirements as `any` — a deliberate erasure at the
 * boundary between ~57 heterogeneous tool implementations and the single `McpServer.addTool`
 * signature (see the comment on the type in `mcp/tools/registry.ts`). `@maple/llm`'s `Tool.make`
 * insists on `never`, and `any` is not assignable to `never` in that position, so the erasure has
 * to be undone somewhere. Doing it here, once and by name, keeps it visible: the services really
 * are supplied, by the `ManagedRuntime` each caller builds around its loop.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const withRuntimeServices = <A, E>(effect: Effect.Effect<A, E, any>): Effect.Effect<A, E> =>
	effect as Effect.Effect<A, E>

/**
 * Serialize an MCP tool result for the model. Maple's tools already return model-facing text
 * blocks, so this is a join rather than a re-encode; `isError` is surfaced as a `ToolFailure` so
 * the runtime emits a `tool-error` event and the model can self-correct.
 *
 * Bounded here, at creation, and never again — see `./tool-output.ts` for why that matters more than
 * the token saving. A warehouse query with no `limit` used to enter the transcript whole.
 */
export const toolResultText = (result: { content: ReadonlyArray<{ text: string }> }): string =>
	truncateToolOutput(result.content.map((block) => block.text).join("\n")).text

/**
 * A one-line reason for a failed tool, safe to hand the model.
 *
 * `String(cause)` renders the whole Effect cause: stack frames, and — inside a `DatabaseError` —
 * connection details. That went into the model's context and, through the tool-result event, into
 * a durable transcript the browser reads back.
 *
 * Capped, because "one line" is a convention the error's author never agreed to: a ClickHouse
 * syntax error arrives with the whole offending query inlined, and on a retry loop that lands in the
 * transcript once per attempt.
 */
const MAX_FAILURE_MESSAGE_CHARS = 500

const cap = (message: string): string =>
	message.length <= MAX_FAILURE_MESSAGE_CHARS
		? message
		: `${message.slice(0, MAX_FAILURE_MESSAGE_CHARS)}…[truncated]`

export const summarizeToolFailure = (cause: Cause.Cause<unknown>): string => {
	const failure = cause.reasons.find(Cause.isFailReason)
	const error: unknown = failure?.error
	if (error instanceof Error) return cap(error.message)
	if (error && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message
		if (typeof message === "string") return cap(message)
	}
	return "the tool failed"
}

/**
 * Description suffix on gated tools. The model still calls them normally; it just needs to know
 * the call is a proposal so it stops rather than narrating a completed change.
 */
export const APPROVAL_NOTE =
	"\n\nThis is an approval-gated action. Calling it proposes the change for the user to approve; " +
	"it does NOT take effect until they do. Call it once with the intended arguments and stop."

export interface BuildMapleToolsOptions {
	/** Which registry tools to expose. Defaults to all of them. */
	readonly include?: (name: string) => boolean
	/**
	 * Which exposed tools are approval-gated. A gated tool keeps a real handler so the schema the
	 * model sees is identical to the ungated case, but the handler refuses: the caller's loop is
	 * expected to break on the proposal before ever dispatching it.
	 */
	readonly gate?: (name: string) => boolean
}

/** Wrap the Maple MCP registry as `@maple/llm` tools. */
export const buildMapleTools = (tenant: TenantContext, options: BuildMapleToolsOptions = {}): Tools =>
	Object.fromEntries(
		mapleToolDefinitions
			.filter((definition) => options.include?.(definition.name) ?? true)
			.map((definition) => {
				const gated = options.gate?.(definition.name) ?? false
				return [
					definition.name,
					Tool.make({
						description: gated
							? `${definition.description}${APPROVAL_NOTE}`
							: definition.description,
						jsonSchema: toInputSchema(definition.schema),
						execute: (params): Effect.Effect<unknown, ToolFailure> =>
							gated
								? Effect.fail(
										new ToolFailure({
											message: `${definition.name} requires user approval and was not executed.`,
										}),
									)
								: withRuntimeServices(
										callMcpTool(definition.name, params).pipe(
											Effect.provideService(CurrentMcpTenant, tenant),
											Effect.flatMap((result) =>
												result.isError
													? Effect.fail(
															new ToolFailure({
																message: toolResultText(result),
															}),
														)
													: Effect.succeed(toolResultText(result)),
											),
											// A tool that fails outright (unknown tool, tenant error) must
											// not kill the turn — hand the model the message and let it
											// route around.
											Effect.catchCause((cause) =>
												Effect.fail(
													new ToolFailure({
														message: `Tool failed: ${summarizeToolFailure(cause)}`,
													}),
												),
											),
										),
									),
					}),
				]
			}),
	)
