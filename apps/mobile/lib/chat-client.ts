import { fetch as expoFetch } from "expo/fetch"
import { chatApiBaseUrl, parseChatSendResponse, type ChatSendResponse } from "./chat-protocol"

/**
 * `expo/fetch`'s response type — RN's built-in `fetch` can't read streaming
 * response bodies, which the durable event stream needs, so every request here
 * goes through `expo/fetch` instead (its `Response.body` is a real
 * `ReadableStream`).
 */
type ExpoFetchResponse = Awaited<ReturnType<typeof expoFetch>>

const sessionPath = (sessionId: string, suffix: string): string =>
	`${chatApiBaseUrl}/api/chat/sessions/${encodeURIComponent(sessionId)}${suffix}`

async function authHeaders(getToken: () => Promise<string | null>): Promise<Record<string, string>> {
	const token = await getToken()
	return token ? { Authorization: `Bearer ${token}` } : {}
}

export interface MapleChatClient {
	/** POST the full message text (context preamble already folded in). */
	sendMessage(sessionId: string, text: string, signal?: AbortSignal): Promise<ChatSendResponse>
	/** Tail the durable event stream from `cursor`. */
	openEventStream(sessionId: string, cursor: number, signal?: AbortSignal): Promise<ExpoFetchResponse>
	/** Best-effort: ask the server to abort the running turn. */
	abort(sessionId: string, signal?: AbortSignal): Promise<void>
}

/**
 * Build a client for Maple's own durable chat transport
 * (`apps/api`'s `/api/chat/sessions/:sessionId/*` routes), replacing the
 * `@flue/sdk` client this file used to build.
 *
 * `getToken` resolves per request — including per stream reconnect — so every
 * call attaches a fresh Clerk session token; the API's chat middleware verifies
 * it and checks the caller's org owns the addressed session.
 */
export function makeMapleChatClient(getToken: () => Promise<string | null>): MapleChatClient {
	return {
		async sendMessage(sessionId, text, signal) {
			const response = await expoFetch(sessionPath(sessionId, "/messages"), {
				method: "POST",
				headers: { ...(await authHeaders(getToken)), "content-type": "application/json" },
				body: JSON.stringify({ text }),
				signal,
			})
			if (!response.ok) throw new Error(`Failed to send message: ${response.status}`)
			const json: unknown = await response.json()
			const parsed = parseChatSendResponse(json)
			if (!parsed) throw new Error("Malformed chat send response")
			return parsed
		},

		async openEventStream(sessionId, cursor, signal) {
			return expoFetch(sessionPath(sessionId, `/events?cursor=${cursor}`), {
				headers: await authHeaders(getToken),
				signal,
			})
		},

		async abort(sessionId, signal) {
			await expoFetch(sessionPath(sessionId, "/abort"), {
				method: "POST",
				headers: await authHeaders(getToken),
				signal,
			})
		},
	}
}
