import { DiagnoseServiceToolInput } from "@maple/domain"
import type { McpToolRegistrar } from "./types"
import { executeDiagnoseServiceTool } from "@/chat/observability-tools"
import { registerStructuredTool } from "./register-structured-tool"

export function registerDiagnoseServiceTool(server: McpToolRegistrar) {
  registerStructuredTool(server, "diagnose_service", DiagnoseServiceToolInput, executeDiagnoseServiceTool)
}
