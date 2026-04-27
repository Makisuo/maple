import { AsyncLocalStorage } from "node:async_hooks"
import type { McpSchema } from "effect/unstable/ai"

export type SessionPayload = typeof McpSchema.Initialize.payloadSchema.Type

const SESSION_TTL_SECONDS = 60 * 60 * 24

interface KvLike {
  readonly get: (key: string, type: "json") => Promise<unknown>
  readonly put: (
    key: string,
    value: string,
    options?: { readonly expirationTtl?: number },
  ) => Promise<void>
}

interface CtxLike {
  readonly waitUntil: (promise: Promise<unknown>) => void
}

interface RequestBindings {
  readonly ctx: CtxLike
  readonly kv: KvLike | undefined
}

const requestStore = new AsyncLocalStorage<RequestBindings>()

export const runWithSessionBindings = <T>(
  bindings: RequestBindings,
  fn: () => T,
): T => requestStore.run(bindings, fn)

export class SessionStore extends Map<string, SessionPayload> {
  async preload(sessionId: string): Promise<void> {
    if (this.has(sessionId)) return
    const store = requestStore.getStore()
    if (!store?.kv) return
    try {
      const value = (await store.kv.get(sessionId, "json")) as
        | SessionPayload
        | null
      if (value) super.set(sessionId, value)
    } catch (err) {
      console.error("[mcp-session-kv] preload failed:", err)
    }
  }

  override set(key: string, value: SessionPayload): this {
    super.set(key, value)
    const store = requestStore.getStore()
    if (store?.kv) {
      store.ctx.waitUntil(
        store.kv
          .put(key, JSON.stringify(value), {
            expirationTtl: SESSION_TTL_SECONDS,
          })
          .catch((err) =>
            console.error("[mcp-session-kv] put failed:", err),
          ),
      )
    }
    return this
  }
}

export const sessionStore = new SessionStore()
