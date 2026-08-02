// Wire types for Maple's own durable chat transport, mirroring
// `packages/domain/src/chat-session.ts` by hand rather than importing it: this
// app isn't a bun workspace member (nothing under `@maple/*` resolves here — see
// `api.ts`'s "we deliberately don't import the Effect schema" note), and it
// stays Effect-free on purpose. Keep this in sync with `chat-session.ts` by hand
// whenever the wire contract changes.

/** `"<orgId>:<tabId>"` — mirrors `makeChatSessionId` server-side. The org is
 * recovered from it server-side and checked against the caller's token. */
export const makeChatSessionId = (orgId: string, tabId: string): string => `${orgId}:${tabId}`

/** Base URL of the Maple API. Chat now lives on the same origin as every other
 * `/api/*` route — there is no separate chat backend to point at. */
export const chatApiBaseUrl: string =
	process.env.EXPO_PUBLIC_API_BASE_URL ?? (__DEV__ ? "http://127.0.0.1:3472" : "https://api.maple.dev")

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

export interface ChatUserMessageEvent {
	seq: number
	type: "user-message"
	id: string
	text: string
}

export interface ChatTurnStartEvent {
	seq: number
	type: "turn-start"
	messageId: string
}

export interface ChatTextDeltaEvent {
	seq: number
	type: "text-delta"
	messageId: string
	text: string
}

export interface ChatToolCallEvent {
	seq: number
	type: "tool-call"
	messageId: string
	callId: string
	name: string
	input: unknown
	/** Approval-gated mutation: the tool did not run, this is a proposal. */
	proposed?: boolean
}

export interface ChatToolResultEvent {
	seq: number
	type: "tool-result"
	messageId: string
	callId: string
	output: unknown
	isError?: boolean
}

export interface ChatTurnEndEvent {
	seq: number
	type: "turn-end"
	messageId: string
	reason: "stop" | "aborted" | "error" | "max-steps"
	/** Present when `reason` is `"error"`. */
	error?: string
}

export type ChatEvent =
	| ChatUserMessageEvent
	| ChatTurnStartEvent
	| ChatTextDeltaEvent
	| ChatToolCallEvent
	| ChatToolResultEvent
	| ChatTurnEndEvent

export interface ChatSendResponse {
	/** Cursor immediately BEFORE this submission's first event. */
	cursor: number
	messageId: string
}

// ---------------------------------------------------------------------------
// Parsing — hand-rolled narrowing instead of a cast, since this is untrusted
// bytes off the wire. Any field that fails to match its expected shape fails
// the whole frame rather than smuggling a bad value past the type system.
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const asNumber = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined)
const asBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined)

const isTurnEndReason = (value: string): value is ChatTurnEndEvent["reason"] =>
	value === "stop" || value === "aborted" || value === "error" || value === "max-steps"

/** Parse one SSE `data:` payload into a {@link ChatEvent}, or `null` if it
 * doesn't match the shape this client understands — the caller should skip the
 * frame rather than crash the stream reader over it. */
export function parseChatEvent(raw: string): ChatEvent | null {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		return null
	}
	if (!isRecord(value)) return null

	const seq = asNumber(value.seq)
	if (seq === undefined) return null
	const type = asString(value.type)

	switch (type) {
		case "user-message": {
			const id = asString(value.id)
			const text = asString(value.text)
			return id !== undefined && text !== undefined ? { seq, type, id, text } : null
		}
		case "turn-start": {
			const messageId = asString(value.messageId)
			return messageId !== undefined ? { seq, type, messageId } : null
		}
		case "text-delta": {
			const messageId = asString(value.messageId)
			const text = asString(value.text)
			return messageId !== undefined && text !== undefined ? { seq, type, messageId, text } : null
		}
		case "tool-call": {
			const messageId = asString(value.messageId)
			const callId = asString(value.callId)
			const name = asString(value.name)
			if (messageId === undefined || callId === undefined || name === undefined) return null
			return {
				seq,
				type,
				messageId,
				callId,
				name,
				input: value.input,
				proposed: asBoolean(value.proposed),
			}
		}
		case "tool-result": {
			const messageId = asString(value.messageId)
			const callId = asString(value.callId)
			if (messageId === undefined || callId === undefined) return null
			return { seq, type, messageId, callId, output: value.output, isError: asBoolean(value.isError) }
		}
		case "turn-end": {
			const messageId = asString(value.messageId)
			const reason = asString(value.reason)
			if (messageId === undefined || reason === undefined || !isTurnEndReason(reason)) return null
			return { seq, type, messageId, reason, error: asString(value.error) }
		}
		default:
			return null
	}
}

/** Parse a `POST .../messages` JSON body into a {@link ChatSendResponse}, or `null`. */
export function parseChatSendResponse(value: unknown): ChatSendResponse | null {
	if (!isRecord(value)) return null
	const cursor = asNumber(value.cursor)
	const messageId = asString(value.messageId)
	return cursor !== undefined && messageId !== undefined ? { cursor, messageId } : null
}
