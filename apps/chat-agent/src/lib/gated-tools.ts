import type { ToolSet } from "ai"
import { GATED_TOOL_NAMES } from "@maple/ai"

export { GATED_TOOL_NAMES }

export function applyApprovalGates(tools: ToolSet): ToolSet {
	const out: ToolSet = {}
	for (const [name, t] of Object.entries(tools)) {
		out[name] = GATED_TOOL_NAMES.has(name)
			? ({ ...(t as Record<string, unknown>), needsApproval: true } as ToolSet[string])
			: t
	}
	return out
}
