import alchemy from "alchemy"
import { Vite } from "alchemy/cloudflare"
import { CloudflareStateStore } from "alchemy/state"
import path from "node:path"
import {
  parseRailwayDeploymentTarget,
  provisionRailwayStack,
} from "@maple/infra/railway"

const app = await alchemy("maple-web", {
  ...(process.env.ALCHEMY_STATE_TOKEN
    ? {
        stateStore: (scope) => new CloudflareStateStore(scope),
      }
    : {}),
})

const deploymentTarget = parseRailwayDeploymentTarget(app.stage)
const railway = await provisionRailwayStack({
  target: deploymentTarget,
})

if (!process.env.VITE_MAPLE_AUTH_MODE) {
  process.env.VITE_MAPLE_AUTH_MODE = process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted"
}

if (!process.env.VITE_CLERK_PUBLISHABLE_KEY) {
  process.env.VITE_CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY?.trim() || ""
}

process.env.VITE_API_BASE_URL = railway.apiUrl
process.env.VITE_INGEST_URL = railway.ingestUrl

const chatAgentUrl =
  deploymentTarget.kind === "prd"
    ? "https://chat.maple.dev"
    : deploymentTarget.kind === "stg"
      ? "https://chat-staging.maple.dev"
      : process.env.VITE_CHAT_AGENT_URL ?? ""
if (chatAgentUrl) {
  process.env.VITE_CHAT_AGENT_URL = chatAgentUrl
}

const webDomains =
  deploymentTarget.kind === "prd"
    ? [
        {
          domainName: "app.maple.dev",
          adopt: true,
        },
      ]
    : deploymentTarget.kind === "stg"
      ? [
          {
            domainName: "staging.maple.dev",
            adopt: true,
          },
        ]
    : undefined

export const website = await Vite("app", {
  entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
  domains: webDomains,
})

console.log({
  stage: app.stage,
  railwayStage: railway.stage,
  railwayEnvironment: railway.environmentName,
  apiUrl: railway.apiUrl,
  ingestUrl: railway.ingestUrl,
  webUrl: webDomains?.[0]?.domainName ? `https://${webDomains[0].domainName}` : website.url,
  projectId: railway.projectId,
})

await app.finalize()
