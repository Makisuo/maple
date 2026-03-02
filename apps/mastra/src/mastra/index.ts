import { Mastra } from "@mastra/core/mastra"
import { PinoLogger } from "@mastra/loggers"
import { LibSQLStore } from "@mastra/libsql"
import {
  Observability,
  DefaultExporter,
  CloudExporter,
  SensitiveDataFilter,
} from "@mastra/observability"
import { issueWriterAgent } from "./agents/issue-writer"
import { anomalyDetectionWorkflow } from "./workflows/anomaly-detection"
import { tinybirdTools } from "./tools/tinybird-tools"
import { githubTools } from "./tools/github-tools"

export const mastra = new Mastra({
  workflows: { anomalyDetectionWorkflow },
  agents: { issueWriterAgent },
  storage: new LibSQLStore({
    id: "mastra-storage",
    url: "file:./mastra.db",
  }),
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "maple-agent",
        exporters: [
          new DefaultExporter(),
          new CloudExporter(),
        ],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
})
