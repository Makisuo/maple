import type { McpServerConnection, ToolDefinition } from "@flue/runtime"
import type { InternalMcpToolResult } from "@maple/domain/internal-rpc"
import type { ChatFlueEnv } from "./env.ts"
import { mapleApiRpc } from "./api-rpc.ts"

/** Prefix retained for parity with Flue's MCP HTTP adapter. */
const MCP_PREFIX = "mcp__maple__"

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

const sanitizeToolNamePart = (value: string): string =>
	value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "unnamed"

const normalizeInputSchema = (schema: Record<string, unknown>): Record<string, unknown> => ({
	...schema,
	type: schema.type ?? "object",
	properties: schema.properties ?? {},
})

const formatResult = (result: InternalMcpToolResult): string =>
	result.content
		.map((entry) => entry.text)
		.filter(Boolean)
		.join("\n\n") || "(MCP tool returned no content)"

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
 * Adapt API Worker RPC descriptors into the same ordinary Flue tools that the
 * former streamable-HTTP MCP connection returned. The service binding itself
 * authenticates the Worker-to-Worker hop; org scope is explicit and validated
 * again by the API boundary.
 */
export const connectMapleMcp = async (
	env: ChatFlueEnv,
	orgId: string,
	options: ConnectMapleMcpOptions = {},
): Promise<McpServerConnection> => {
	const timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS
	const api = mapleApiRpc(env)
	const descriptors = await withTimeout(api.listMcpTools(), timeoutMs, "listMcpTools")
	const seen = new Set<string>()
	const tools: ToolDefinition[] = descriptors.map((descriptor) => {
		const name = `${MCP_PREFIX}${sanitizeToolNamePart(descriptor.name)}`
		if (seen.has(name)) throw new Error(`Maple RPC tools produced duplicate tool name "${name}"`)
		seen.add(name)

		return {
			name,
			description: `MCP tool "${descriptor.name}" from server "maple". ${descriptor.description}`,
			parameters: normalizeInputSchema(descriptor.inputSchema),
			execute: async (input, signal) => {
				if (signal?.aborted) throw new Error("Operation aborted")
				const result = await withTimeout(
					api.callMcpTool({ orgId, name: descriptor.name, input }),
					timeoutMs,
					`callMcpTool(${descriptor.name})`,
				)
				const text = formatResult(result)
				if (result.isError) throw new Error(text)
				return text
			},
		}
	})

	return {
		name: "maple",
		tools: options.allowlist ? filterMcpTools(tools, options.allowlist) : tools,
		close: async () => undefined,
	}
}
