import { defineTool, type JsonValue, type ToolDefinition } from "@flue/runtime"
import type { InternalMcpToolDescriptor, InternalMcpToolResult } from "@maple/domain/internal-rpc"
import type { ChatFlueEnv } from "./env.ts"
import { mapleApiRpc } from "./api-rpc.ts"
import { jsonSchemaToValibot } from "./json-schema-to-valibot.ts"

/**
 * A resolved set of Maple tools, adapted from the API's RPC registry.
 *
 * Flue 2 dropped `McpServerConnection` along with its own MCP server plumbing —
 * `useMcpConnection()` now owns that path. We stay on the hand-rolled adapter
 * because Flue's MCP adapter flattens a tool result into ONE string, which would
 * re-inline the `__maple_ui` payload into the model's context window (the exact
 * regression {@link splitToolResult} exists to avoid) and route tool calls over
 * HTTP instead of the `MAPLE_API_RPC` service binding.
 */
export interface MapleToolConnection {
	readonly name: string
	readonly tools: readonly ToolDefinition[]
	readonly close: () => Promise<void>
}

/** Prefix retained for parity with Flue's MCP HTTP adapter. */
const MCP_PREFIX = "mcp__maple__"

/** Marks the second content entry of a Maple tool result as the UI payload. */
const STRUCTURED_MARKER = "__maple_ui"

/** Strip the `mcp__maple__` prefix to recover the registry tool name. */
export const baseToolName = (name: string): string =>
	name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name

/** Keep only the tools whose base (unprefixed) name is in the allowlist. */
export const filterMcpTools = <T extends { name: string }>(
	tools: readonly T[],
	allowlist: ReadonlySet<string>,
): T[] => tools.filter((tool) => allowlist.has(baseToolName(tool.name)))

/** Default internal RPC timeout (ms): an unavailable API fails the turn promptly. */
export const MCP_DEFAULT_TIMEOUT_MS = 12_000

export interface ConnectMapleMcpOptions {
	/** If set, keep only tools whose base name is in this allowlist (e.g. the triage subset). */
	allowlist?: ReadonlySet<string>
	/** Worker RPC timeout in ms. Defaults to {@link MCP_DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number
}

/**
 * What a Maple tool hands back. `text` is the human-readable report the model
 * reasons over; `ui` is the structured payload the web renders as a table, chart
 * or tree (`apps/api`'s `createDualContent` emits the two as separate content
 * entries, tagged with `__maple_ui`).
 *
 * They travel as one object because a Flue tool has a single return value that
 * serves both consumers. Splitting them here is still strictly better than the
 * previous string join: the model used to receive the raw UI JSON inlined in its
 * text, and the browser received a string it could not parse back into anything.
 */
export type MapleToolOutput = {
	text: string
	ui?: JsonValue
}

const sanitizeToolNamePart = (value: string): string =>
	value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "unnamed"

/** A content entry that is the `__maple_ui` payload, or `undefined` for report text. */
const parseUiPayload = (text: string): JsonValue | undefined => {
	try {
		// `JSON.parse` is `any`; the value genuinely is JSON, so `JsonValue` is the
		// honest type rather than a cast.
		const parsed: JsonValue = JSON.parse(text)
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return STRUCTURED_MARKER in parsed ? parsed : undefined
		}
	} catch {
		// Not JSON — ordinary report text.
	}
	return undefined
}

/** Split a Maple MCP result into the model-facing text and the UI payload. */
export const splitToolResult = (result: InternalMcpToolResult): MapleToolOutput => {
	const texts: string[] = []
	let ui: JsonValue | undefined
	for (const entry of result.content) {
		if (!entry.text) continue
		if (ui === undefined) {
			const parsed = parseUiPayload(entry.text)
			if (parsed !== undefined) {
				ui = parsed
				continue
			}
		}
		texts.push(entry.text)
	}
	const text = texts.join("\n\n") || "(MCP tool returned no content)"
	return ui === undefined ? { text } : { text, ui }
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> => {
	let timeout: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
					timeoutMs,
				)
			}),
		])
	} finally {
		if (timeout !== undefined) clearTimeout(timeout)
	}
}

/**
 * Read the tool registry from the API.
 *
 * Split out from {@link buildMapleTools} because the two have very different
 * lifetimes: the registry is deployment-static (`listMcpTools` is a pure
 * constant on the API side — it takes no org and does no I/O of its own), while
 * the tools built from it close over one org. A Flue 2 agent renders
 * SYNCHRONOUSLY, so the async half has to happen off the render path — see
 * `useAgentStart` in `src/agents/maple-chat.ts`.
 */
export const fetchMapleToolDescriptors = async (
	env: ChatFlueEnv,
	timeoutMs: number = MCP_DEFAULT_TIMEOUT_MS,
): Promise<readonly InternalMcpToolDescriptor[]> =>
	withTimeout(mapleApiRpc(env).listMcpTools(), timeoutMs, "listMcpTools")

/**
 * Adapt API Worker RPC descriptors into ordinary Flue tools. The service binding
 * itself authenticates the Worker-to-Worker hop; org scope is explicit and
 * validated again by the API boundary.
 *
 * Synchronous on purpose: an agent render may call it.
 */
export const buildMapleTools = (
	env: ChatFlueEnv,
	orgId: string,
	descriptors: readonly InternalMcpToolDescriptor[],
	options: ConnectMapleMcpOptions = {},
): readonly ToolDefinition[] => {
	const timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS
	const api = mapleApiRpc(env)
	const seen = new Set<string>()
	const tools: ToolDefinition[] = descriptors.map((descriptor) => {
		const name = `${MCP_PREFIX}${sanitizeToolNamePart(descriptor.name)}`
		if (seen.has(name)) throw new Error(`Maple RPC tools produced duplicate tool name "${name}"`)
		seen.add(name)

		return defineTool({
			name,
			description: `MCP tool "${descriptor.name}" from server "maple". ${descriptor.description}`,
			input: jsonSchemaToValibot(descriptor.inputSchema),
			output: undefined,
			run: async ({ data, signal }) => {
				if (signal?.aborted) throw new Error("Operation aborted")
				const result = await withTimeout(
					api.callMcpTool({ orgId, name: descriptor.name, input: data }),
					timeoutMs,
					`callMcpTool(${descriptor.name})`,
				)
				const output = splitToolResult(result)
				if (result.isError) throw new Error(output.text)
				return { output }
			},
		})
	})

	return options.allowlist ? filterMcpTools(tools, options.allowlist) : tools
}

/**
 * Fetch-and-build in one await, for the headless callers that can afford it
 * (the triage agent's start hook). The chat agent uses the two halves directly
 * so its render stays synchronous.
 */
export const connectMapleMcp = async (
	env: ChatFlueEnv,
	orgId: string,
	options: ConnectMapleMcpOptions = {},
): Promise<MapleToolConnection> => ({
	name: "maple",
	tools: buildMapleTools(env, orgId, await fetchMapleToolDescriptors(env, options.timeoutMs), options),
	close: async () => undefined,
})
