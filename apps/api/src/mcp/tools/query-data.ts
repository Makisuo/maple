import type { McpToolRegistrar } from "./types"
import { executeQueryDataTool } from "@/chat/observability-tools"
import { registerStructuredTool } from "./register-structured-tool"
import { queryDataArgsSchema } from "./query-data-shared"
export {
  buildQuerySpec,
  decodeQuerySpecSync,
  queryDataArgsSchema,
  queryDataToolDescription,
  type QueryDataArgs,
} from "./query-data-shared"

export function registerQueryDataTool(server: McpToolRegistrar) {
  registerStructuredTool(server, "query_data", queryDataArgsSchema, executeQueryDataTool)
}
