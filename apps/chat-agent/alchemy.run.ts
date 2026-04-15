import path from "node:path"
import alchemy from "alchemy"
import { DurableObjectNamespace, Worker } from "alchemy/cloudflare"
import type {
  MapleDomains,
  MapleStage,
} from "@maple/infra/cloudflare"
import { resolveWorkerName } from "@maple/infra/cloudflare"

export interface CreateChatAgentWorkerOptions {
  stage: MapleStage
  domains: MapleDomains
  mapleApiUrl: string
}

export const createChatAgentWorker = async ({
  stage,
  domains,
  mapleApiUrl,
}: CreateChatAgentWorkerOptions) => {
  const chatAgentDO = DurableObjectNamespace("chat-agent-do", {
    className: "ChatAgent",
    sqlite: true,
  })

  const worker = await Worker("chat-agent", {
    name: resolveWorkerName("chat-agent", stage),
    cwd: import.meta.dirname,
    entrypoint: path.join(import.meta.dirname, "src", "index.ts"),
    compatibility: "node",
    url: true,
    adopt: true,
    domains: domains.chat
      ? [{ domainName: domains.chat, adopt: true }]
      : undefined,
    bindings: {
      ChatAgent: chatAgentDO,
      MAPLE_API_URL: mapleApiUrl,
      INTERNAL_SERVICE_TOKEN: alchemy.secret(process.env.INTERNAL_SERVICE_TOKEN),
      OPENROUTER_API_KEY: alchemy.secret(process.env.OPENROUTER_API_KEY),
    },
  })

  return worker
}
