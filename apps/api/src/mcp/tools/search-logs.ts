import { SearchLogsToolInput } from "@maple/domain"
import type { McpToolRegistrar } from "./types"
import { executeSearchLogsTool } from "@/chat/observability-tools"
import { registerStructuredTool } from "./register-structured-tool"

export function registerSearchLogsTool(server: McpToolRegistrar) {
  registerStructuredTool(server, "search_logs", SearchLogsToolInput, executeSearchLogsTool)
}
