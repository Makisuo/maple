const configuredMcpUrl = import.meta.env.VITE_MCP_URL?.trim()
const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()

export const mcpUrl =
  configuredMcpUrl && configuredMcpUrl.length > 0
    ? configuredMcpUrl.replace(/\/$/, "")
    : apiBaseUrl && apiBaseUrl.length > 0
      ? apiBaseUrl.replace(/\/$/, "")
      : "http://localhost:3472"
