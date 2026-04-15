import alchemy from "alchemy"
import { CloudflareStateStore } from "alchemy/state"
import { parseMapleStage, resolveMapleDomains } from "@maple/infra/cloudflare"
import { createAlertingWorker } from "./apps/alerting/alchemy.run.ts"
import { createMapleApi } from "./apps/api/alchemy.run.ts"
import { createChatAgentWorker } from "./apps/chat-agent/alchemy.run.ts"
import { createLandingWorker } from "./apps/landing/alchemy.run.ts"
import { createMapleWeb } from "./apps/web/alchemy.run.ts"

const requireEnv = (key: string): string => {
  const value = process.env[key]?.trim()
  if (!value) {
    throw new Error(`Missing required deployment env: ${key}`)
  }
  return value
}

const app = await alchemy("maple", {
  password: requireEnv("ALCHEMY_PASSWORD"),
  ...(process.env.ALCHEMY_STATE_TOKEN
    ? { stateStore: (scope) => new CloudflareStateStore(scope) }
    : {}),
})

const stage = parseMapleStage(app.stage)
const domains = resolveMapleDomains(stage)

const { worker: api, db: mapleDb } = await createMapleApi({ stage, domains })

const resolvedApiUrl = domains.api ? `https://${domains.api}` : api.url
if (!resolvedApiUrl) {
  throw new Error(
    "api worker deployed without a url — set `url: true` or provide a custom domain",
  )
}

const chatAgent = await createChatAgentWorker({
  stage,
  domains,
  mapleApiUrl: resolvedApiUrl,
})

const resolvedChatAgentUrl = domains.chat
  ? `https://${domains.chat}`
  : chatAgent.url
if (!resolvedChatAgentUrl) {
  throw new Error(
    "chat-agent worker deployed without a url — set `url: true` or provide a custom domain",
  )
}

// ingest is not currently deployed via alchemy; for non-custom-domain stages,
// fall back to a caller-supplied env var or localhost.
const resolvedIngestUrl = domains.ingest
  ? `https://${domains.ingest}`
  : process.env.VITE_INGEST_URL?.trim() || "http://127.0.0.1:3474"

const web = await createMapleWeb({
  stage,
  domains,
  apiUrl: resolvedApiUrl,
  ingestUrl: resolvedIngestUrl,
  chatAgentUrl: resolvedChatAgentUrl,
})

const landing = await createLandingWorker({ stage, domains })

const alerting = await createAlertingWorker({ stage, domains, mapleDb })

console.log({
  stage: app.stage,
  apiUrl: resolvedApiUrl,
  chatAgentUrl: resolvedChatAgentUrl,
  ingestUrl: resolvedIngestUrl,
  webUrl: domains.web ? `https://${domains.web}` : web.url,
  landingUrl: domains.landing ? `https://${domains.landing}` : landing.url,
  alertingWorker: alerting.name,
})

await app.finalize()
