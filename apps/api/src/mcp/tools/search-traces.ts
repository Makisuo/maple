import { SearchTracesToolInput } from "@maple/domain"
import type { McpToolRegistrar } from "./types"
import { executeSearchTracesTool } from "@/chat/observability-tools"
import { registerStructuredTool } from "./register-structured-tool"

export function registerSearchTracesTool(server: McpToolRegistrar) {
  registerStructuredTool(server, "search_traces", SearchTracesToolInput, executeSearchTracesTool)
}
