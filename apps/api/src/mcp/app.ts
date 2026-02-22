import { McpServer } from "@effect/ai"
import { Layer } from "effect"
import { McpToolsLive } from "./server"

export const McpLive = McpToolsLive.pipe(
  Layer.provideMerge(
    McpServer.layerHttpRouter({
      name: "maple-observability",
      version: "1.0.0",
      path: "/mcp",
    }),
  ),
)
