// Chat-agent deployment is disabled during the alchemy v2 migration.
//
// alchemy@2.0.0-beta.3's DurableObjectNamespace API generates its DO class from
// an Effect.gen body — it does not accept a plain `className: "ChatAgent"`
// string reference to a user-defined class. Since `apps/chat-agent/src/index.ts`
// extends `AIChatAgent` from `@cloudflare/ai-chat` (a class-inheritance
// framework), a full runtime rewrite is needed before we can re-stack it here.
//
// Until that rewrite lands, chat-agent is not deployable via alchemy. The
// `deploy:stack` / `destroy:stack` scripts in apps/chat-agent/package.json
// will fail — track as a follow-up migration task.

export default undefined

/* Original v1 stack — restore and port when the DO runtime is rewritten.

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

// ... rest of the original stack. See git history for the full implementation.
*/
