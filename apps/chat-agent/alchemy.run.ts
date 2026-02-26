import alchemy from "alchemy"
import { Worker, DurableObjectNamespace } from "alchemy/cloudflare"
import { CloudflareStateStore } from "alchemy/state"

const app = await alchemy("maple-chat-agent", {
  ...(process.env.ALCHEMY_STATE_TOKEN
    ? { stateStore: (scope) => new CloudflareStateStore(scope) }
    : {}),
})

const chatAgentDO = DurableObjectNamespace("chat-agent-do", {
  className: "ChatAgent",
  sqlite: true,
})

const domains =
  app.stage === "prd"
    ? [{ domainName: "chat.maple.dev", adopt: true }]
    : app.stage === "stg"
      ? [{ domainName: "chat-staging.maple.dev", adopt: true }]
      : undefined

const workerName =
  app.stage === "prd"
    ? "maple-chat-agent"
    : app.stage === "stg"
      ? "maple-chat-agent-stg"
      : `maple-chat-agent-${app.stage}`

export const chatWorker = await Worker("chat-agent", {
  name: workerName,
  entrypoint: "./src/index.ts",
  compatibility: "node",
  url: true,
  bindings: {
    ChatAgent: chatAgentDO,
    MAPLE_API_URL: process.env.MAPLE_API_URL ?? "http://localhost:3472",
    INTERNAL_SERVICE_TOKEN: alchemy.secret(process.env.INTERNAL_SERVICE_TOKEN),
    OPENROUTER_API_KEY: alchemy.secret(process.env.OPENROUTER_API_KEY),
  },
  domains,
  adopt: true,
})

console.log({ stage: app.stage, chatWorkerUrl: chatWorker.url })
await app.finalize()
