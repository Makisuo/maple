// BOUNDARY: This module intentionally carries opaque values; callers decode them before domain use.
import { Effect } from "effect"
import type { McpSchema } from "effect/unstable/ai"

export type SessionPayload = typeof McpSchema.Initialize.payloadSchema.Type

const SESSION_TTL_SECONDS = 60 * 60 * 24

export interface SessionsBinding {
	readonly get: (key: string, type: "json") => Promise<unknown>
	readonly put: (key: string, value: string, options?: { readonly expirationTtl?: number }) => Promise<void>
}

// Plain in-memory Map handed to Effect's MCP layer via `clientSessions`. KV
// reads/writes are driven from worker.ts in the outer async context — see the
// note there for why we don't do them inside an override on this Map.
export const sessionStore = new Map<string, SessionPayload>()

export const preloadSession = (kv: SessionsBinding, sessionId: string): Promise<void> =>
	Effect.gen(function* () {
		if (sessionStore.has(sessionId)) return
		const value = yield* Effect.tryPromise(() => kv.get(sessionId, "json"))
		if (value) sessionStore.set(sessionId, value as SessionPayload)
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.logError("[mcp-session-kv] preload failed").pipe(
				Effect.annotateLogs({ sessionId, cause }),
			),
		),
		Effect.runPromise,
	)

export const persistSession = (kv: SessionsBinding, sessionId: string): Promise<void> | undefined => {
	const payload = sessionStore.get(sessionId)
	if (!payload) return undefined
	return Effect.tryPromise(() =>
		kv.put(sessionId, JSON.stringify(payload), { expirationTtl: SESSION_TTL_SECONDS }),
	).pipe(
		Effect.catchCause((cause) =>
			Effect.logError("[mcp-session-kv] put failed").pipe(Effect.annotateLogs({ sessionId, cause })),
		),
		Effect.runPromise,
	)
}
