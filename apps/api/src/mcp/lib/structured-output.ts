import type { StructuredToolOutput } from "@maple/domain"
import type { McpToolResult } from "@/mcp/tools/types"

export const STRUCTURED_MARKER = "__maple_ui"

export function createDualContent(
  text: string,
  data: Record<string, unknown>,
) {
  return [
    { type: "text" as const, text },
    {
      type: "text" as const,
      text: JSON.stringify({ [STRUCTURED_MARKER]: true, ...data }),
    },
  ]
}

export function createStructuredToolResult(
  data: StructuredToolOutput,
): McpToolResult {
  return {
    summaryText: data.summaryText,
    structuredData: data,
    content: createDualContent(data.summaryText, data),
  }
}
