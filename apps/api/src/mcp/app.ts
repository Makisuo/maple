import { McpServer } from "effect/unstable/ai"
import { Layer } from "effect"
import { McpToolsLive } from "./server"
import { DebugErrorsPrompt } from "./prompts/debug-errors"
import { LatencyAnalysisPrompt } from "./prompts/latency-analysis"
import { IncidentTriagePrompt } from "./prompts/incident-triage"
import { InstructionsResource } from "./resources/instructions"

export const McpLive = Layer.mergeAll(
  McpToolsLive,
  DebugErrorsPrompt,
  LatencyAnalysisPrompt,
  IncidentTriagePrompt,
  InstructionsResource,
).pipe(
  Layer.provide(
    McpServer.layerHttp({
      name: "maple-observability",
      version: "1.0.0",
      path: "/mcp",
    }),
  ),
)
