import type { ChatAgent } from "../index"

export interface Env {
  ChatAgent: DurableObjectNamespace<ChatAgent>
  MAPLE_API_URL: string
  INTERNAL_SERVICE_TOKEN: string
  OPENROUTER_API_KEY: string
}
