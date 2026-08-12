import type * as cf from "@cloudflare/workers-types"
import * as Effect from "effect/Effect"

export type RawWebSocket = cf.WebSocket

export interface DurableWebSocket {
	readonly ws: RawWebSocket
	send(data: string | Uint8Array): Effect.Effect<void>
	close(code: number, reason: string): Effect.Effect<void>
	serializeAttachment<T>(value: T): void
	deserializeAttachment<T>(): T | null
}

export const fromWebSocket = (ws: RawWebSocket): DurableWebSocket => ({
	ws,
	send: (data) => Effect.sync(() => ws.send(data as any)),
	close: (code, reason) => Effect.sync(() => ws.close(code, reason)),
	serializeAttachment: (value) => ws.serializeAttachment(value),
	deserializeAttachment: () => ws.deserializeAttachment() as any,
})
