import alchemy from "alchemy"
import { Vite } from "alchemy/cloudflare"
import { CloudflareStateStore } from "alchemy/state"
import path from "node:path"
import {
  parseMapleStage,
  resolveMapleDomains,
} from "@maple/infra/cloudflare"

const app = await alchemy("maple-web", {
  ...(process.env.ALCHEMY_STATE_TOKEN
    ? { stateStore: (scope) => new CloudflareStateStore(scope) }
    : {}),
})

const stage = parseMapleStage(app.stage)
const domains = resolveMapleDomains(stage)

if (!process.env.VITE_MAPLE_AUTH_MODE) {
  process.env.VITE_MAPLE_AUTH_MODE =
    process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted"
}

if (!process.env.VITE_CLERK_PUBLISHABLE_KEY) {
  process.env.VITE_CLERK_PUBLISHABLE_KEY =
    process.env.CLERK_PUBLISHABLE_KEY?.trim() || ""
}

process.env.VITE_API_BASE_URL = domains.api
  ? `https://${domains.api}`
  : process.env.VITE_API_BASE_URL?.trim() || "http://127.0.0.1:3472"

process.env.VITE_INGEST_URL = domains.ingest
  ? `https://${domains.ingest}`
  : process.env.VITE_INGEST_URL?.trim() || "http://127.0.0.1:3474"

process.env.VITE_CHAT_AGENT_URL = domains.chat
  ? `https://${domains.chat}`
  : process.env.VITE_CHAT_AGENT_URL?.trim() || "http://127.0.0.1:3473"

export const website = await Vite("app", {
  entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
  domains: domains.web
    ? [{ domainName: domains.web, adopt: true }]
    : undefined,
})

console.log({
  stage: app.stage,
  webUrl: domains.web ? `https://${domains.web}` : website.url,
  apiUrl: process.env.VITE_API_BASE_URL,
  ingestUrl: process.env.VITE_INGEST_URL,
  chatAgentUrl: process.env.VITE_CHAT_AGENT_URL,
})

await app.finalize()
