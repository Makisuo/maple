import type { McpSchema } from "effect/unstable/ai"

export type SessionPayload = typeof McpSchema.Initialize.payloadSchema.Type

export const SESSION_TTL_SECONDS = 60 * 60 * 24

export interface SessionsBinding {
	readonly get: (key: string, type: "json") => Promise<unknown>
	readonly put: (key: string, value: string, options?: { readonly expirationTtl?: number }) => Promise<void>
}

// Plain in-memory Map handed to Effect's MCP layer via `clientSessions`. KV
// reads/writes are driven from worker.ts in the outer async context — see the
// note there for why we don't do them inside an override on this Map.
export const sessionStore = new Map<string, SessionPayload>()

export const preloadSession = async (kv: SessionsBinding, sessionId: string): Promise<void> => {
	if (sessionStore.has(sessionId)) return
	try {
		const value = (await kv.get(sessionId, "json")) as SessionPayload | null
		if (value) sessionStore.set(sessionId, value)
	} catch (err) {
		console.error("[mcp-session-kv] preload failed:", err)
	}
}

export const persistSession = (kv: SessionsBinding, sessionId: string): Promise<void> | undefined => {
	const payload = sessionStore.get(sessionId)
	if (!payload) return undefined
	return kv
		.put(sessionId, JSON.stringify(payload), { expirationTtl: SESSION_TTL_SECONDS })
		.catch((err) => console.error("[mcp-session-kv] put failed:", err))
}
