import { SystemHealthToolInput } from "@maple/domain"
import type { McpToolRegistrar } from "./types"
import { executeSystemHealthTool } from "@/chat/observability-tools"
import { registerStructuredTool } from "./register-structured-tool"

export function registerSystemHealthTool(server: McpToolRegistrar) {
  registerStructuredTool(server, "system_health", SystemHealthToolInput, executeSystemHealthTool)
}
