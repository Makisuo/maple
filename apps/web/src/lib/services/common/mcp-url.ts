const configuredMcpUrl = import.meta.env.VITE_MCP_URL?.trim()

export const mcpUrl =
  configuredMcpUrl && configuredMcpUrl.length > 0
    ? configuredMcpUrl.replace(/\/$/, "")
    : "http://127.0.0.1:3473"
