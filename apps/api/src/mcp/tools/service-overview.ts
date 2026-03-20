import { ServiceOverviewToolInput } from "@maple/domain"
import type { McpToolRegistrar } from "./types"
import { executeServiceOverviewTool } from "@/chat/observability-tools"
import { registerStructuredTool } from "./register-structured-tool"

export function registerServiceOverviewTool(server: McpToolRegistrar) {
  registerStructuredTool(server, "service_overview", ServiceOverviewToolInput, executeServiceOverviewTool)
}
