import { InspectTraceToolInput } from "@maple/domain"
import type { McpToolRegistrar } from "./types"
import { executeInspectTraceTool } from "@/chat/observability-tools"
import { registerStructuredTool } from "./register-structured-tool"

export function registerInspectTraceTool(server: McpToolRegistrar) {
  registerStructuredTool(server, "inspect_trace", InspectTraceToolInput, executeInspectTraceTool)
}
