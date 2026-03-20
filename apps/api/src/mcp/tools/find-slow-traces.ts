import { FindSlowTracesToolInput } from "@maple/domain"
import type { McpToolRegistrar } from "./types"
import { executeFindSlowTracesTool } from "@/chat/observability-tools"
import { registerStructuredTool } from "./register-structured-tool"

export function registerFindSlowTracesTool(server: McpToolRegistrar) {
  registerStructuredTool(server, "find_slow_traces", FindSlowTracesToolInput, executeFindSlowTracesTool)
}
