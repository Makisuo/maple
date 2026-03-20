import { ErrorDetailToolInput } from "@maple/domain"
import type { McpToolRegistrar } from "./types"
import { executeErrorDetailTool } from "@/chat/observability-tools"
import { registerStructuredTool } from "./register-structured-tool"

export function registerErrorDetailTool(server: McpToolRegistrar) {
  registerStructuredTool(server, "error_detail", ErrorDetailToolInput, executeErrorDetailTool)
}
