// Copied verbatim from alchemy-effect to stay API-compatible for a future
// migration:
//   https://github.com/alchemy-run/alchemy-effect/blob/main/packages/alchemy/src/Cloudflare/Workers/WebSocket.ts
//
// Effect-native wrapper around Cloudflare WebSocket + `upgrade()` helper for
// accepting a WebSocket inside a Durable Object fetch handler.
import type * as cf from "@cloudflare/workers-types"
import * as Effect from "effect/Effect"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { DurableObjectState } from "./durable-object-state.ts"
import { fromWebSocket } from "./durable-websocket.ts"

export { fromWebSocket, type DurableWebSocket, type RawWebSocket } from "./durable-websocket.ts"

export const upgrade = Effect.fnUntraced(function* () {
	// SAFETY: The global Response constructor is the same runtime constructor described by Workers types.
	const _Response = Response as any as typeof cf.Response
	const ctx = yield* DurableObjectState
	// @ts-expect-error — WebSocketPair is a Worker global
	const [client, server] = new WebSocketPair()
	const serverSocket = fromWebSocket(server)
	yield* ctx.acceptWebSocket(serverSocket)
	const rawResponse = new _Response(null, {
		status: 101,
		webSocket: client,
	})
	const effectResponse = HttpServerResponse.setBody(
		HttpServerResponse.empty({ status: 101 }),
		HttpBody.raw(rawResponse),
	)
	return [effectResponse, serverSocket] as const
})
