import { FindErrorsToolInput } from "@maple/domain"
import type { McpToolRegistrar } from "./types"
import { executeFindErrorsTool } from "@/chat/observability-tools"
import { registerStructuredTool } from "./register-structured-tool"

export function registerFindErrorsTool(server: McpToolRegistrar) {
  registerStructuredTool(server, "find_errors", FindErrorsToolInput, executeFindErrorsTool)
}
