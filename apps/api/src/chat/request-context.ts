import { Layer, ServiceMap } from "effect"
import type { TenantContext } from "@/services/AuthService"

export interface ChatRequestContextValue {
  readonly tenant: TenantContext
  readonly headers: Record<string, string>
}

export class ChatRequestContext extends ServiceMap.Service<
  ChatRequestContext,
  ChatRequestContextValue
>()("ChatRequestContext") {}

export const ChatRequestContextLive = (context: ChatRequestContextValue) =>
  Layer.succeed(ChatRequestContext)(context)
