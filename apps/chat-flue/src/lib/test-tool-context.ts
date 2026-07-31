import type { ToolDefinition } from "@flue/runtime"

/**
 * Invoke a tool the way the runtime does, minus its validation wrapper.
 *
 * Flue 2's `ToolContext` carries `toolCallId` and `log` alongside the parsed
 * `data`, so a bare `{ data }` no longer typechecks. Tests care about none of
 * that — this supplies inert stand-ins and unwraps the result envelope (a bare
 * string being Flue's shorthand for `{ output: string }`), so assertions read
 * against the value the model actually sees.
 */
export const runTool = async (tool: ToolDefinition, data: unknown): Promise<unknown> => {
	const returned = await tool.run({
		toolCallId: "test-call",
		signal: undefined,
		log: { info: () => {}, warn: () => {}, error: () => {} },
		data,
	})
	return typeof returned === "string" ? returned : returned?.output
}
