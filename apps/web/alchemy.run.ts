import path from "node:path"
import { Vite } from "alchemy/cloudflare"
import {
  resolveWorkerName,
  type MapleDomains,
  type MapleStage,
} from "@maple/infra/cloudflare"

export interface CreateMapleWebOptions {
  stage: MapleStage
  domains: MapleDomains
  apiUrl: string
  ingestUrl: string
  chatAgentUrl: string
}

export const createMapleWeb = async ({
  stage,
  domains,
  apiUrl,
  ingestUrl,
  chatAgentUrl,
}: CreateMapleWebOptions) => {
  if (!process.env.VITE_MAPLE_AUTH_MODE) {
    process.env.VITE_MAPLE_AUTH_MODE =
      process.env.MAPLE_AUTH_MODE?.trim() || "self_hosted"
  }

  if (!process.env.VITE_CLERK_PUBLISHABLE_KEY) {
    process.env.VITE_CLERK_PUBLISHABLE_KEY =
      process.env.CLERK_PUBLISHABLE_KEY?.trim() || ""
  }

  process.env.VITE_API_BASE_URL = apiUrl
  process.env.VITE_INGEST_URL = ingestUrl
  process.env.VITE_CHAT_AGENT_URL = chatAgentUrl

  const website = await Vite("app", {
    name: resolveWorkerName("web", stage),
    cwd: import.meta.dirname,
    entrypoint: path.join(import.meta.dirname, "src", "worker.ts"),
    domains: domains.web
      ? [{ domainName: domains.web, adopt: true }]
      : undefined,
  })

  return website
}
