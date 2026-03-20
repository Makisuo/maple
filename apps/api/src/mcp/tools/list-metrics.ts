import { ListMetricsToolInput } from "@maple/domain"
import type { McpToolRegistrar } from "./types"
import { executeListMetricsTool } from "@/chat/observability-tools"
import { registerStructuredTool } from "./register-structured-tool"

export function registerListMetricsTool(server: McpToolRegistrar) {
  registerStructuredTool(server, "list_metrics", ListMetricsToolInput, executeListMetricsTool)
}
