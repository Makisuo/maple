// Streams a single chat turn from Maple's own durable chat transport
// (`apps/api`'s `/api/chat/sessions/:sessionId/*` routes): `client.sendMessage`
// admits the prompt, then `client.openEventStream` tails the session's durable
// event log from the cursor the send returned until the turn ends. Events map
// onto the same callbacks the mobile reducer (`use-mobile-chat.ts`) already
// consumes, so message rendering is unchanged from the transport this replaces.
//
// This file used to pin `@flue/sdk@1.0.0-beta.1` against a beta.9 server, because
// beta.9 dropped the streaming `agents.stream` API this reducer needed in favour
// of `agents.observe`'s materialized-conversation shape — a rewrite that could
// only be validated on a device, so it was deferred rather than done blind.
// Maple's own transport removes that drift entirely: there is no SDK version to
// pin, just the wire contract in `packages/domain/src/chat-session.ts` (mirrored
// by hand in `chat-protocol.ts`, without Effect Schema, since this app is
// deliberately Effect-free and isn't wired into the workspace `@maple/domain`
// resolves from).

import type { MapleChatClient } from "./chat-client"
import { parseChatEvent, type ChatEvent, type ChatTurnEndEvent } from "./chat-protocol"

export interface ChatStreamCallbacks {
	onAssistantStart?: (messageId: string) => void
	onTextDelta?: (partIndex: number, delta: string, textId?: string) => void
	onToolInputStart?: (toolCallId: string, toolName: string) => void
	onToolInputAvailable?: (toolCallId: string, toolName: string, input: unknown) => void
	onToolOutputAvailable?: (toolCallId: string, output: unknown) => void
	onToolError?: (toolCallId: string, errorText: string) => void
	onError?: (errorText: string) => void
	onDone?: () => void
}

interface StreamController {
	abort: () => void
	completion: Promise<void>
}

export interface StreamChatOptions {
	client: MapleChatClient
	/** The org-scoped conversation address (`<orgId>:<tabId>`). */
	sessionId: string
	/** The full message string to send (context preamble already folded in). */
	message: string
	callbacks: ChatStreamCallbacks
}

const isAbort = (err: unknown): boolean => err instanceof Error && err.name === "AbortError"

const errorText = (value: unknown): string => {
	if (value == null) return "Tool error"
	if (typeof value === "string") return value
	if (value instanceof Error) return value.message
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}

export function streamChat({ client, sessionId, message, callbacks }: StreamChatOptions): StreamController {
	const controller = new AbortController()

	const completion = (async () => {
		try {
			const sent = await client.sendMessage(sessionId, message, controller.signal)
			const response = await client.openEventStream(sessionId, sent.cursor, controller.signal)
			if (!response.ok || !response.body) {
				throw new Error(`Chat stream request failed: ${response.status}`)
			}
			await readEventStream(response.body, callbacks)
		} catch (err) {
			if (!isAbort(err)) {
				callbacks.onError?.(err instanceof Error ? err.message : String(err))
			}
		} finally {
			callbacks.onDone?.()
		}
	})()

	return {
		abort: () => {
			controller.abort()
			// Best-effort: the turn settles on its own server-side if this never
			// lands, and there's no affordance here for a failed cancel to report into.
			void client.abort(sessionId).catch(() => {})
		},
		completion,
	}
}

/**
 * Read `data:` frames off the durable event stream until `turn-end` or the
 * connection closes. The server always closes right after `turn-end` (see
 * `chat-session.ts`'s doc comment on `ChatEvent`), so exiting on `done` and
 * exiting on that event agree — this only breaks out early so the UI settles a
 * beat sooner than waiting on the socket to actually close.
 */
async function readEventStream(
	body: ReadableStream<Uint8Array>,
	callbacks: ChatStreamCallbacks,
): Promise<void> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ""

	while (true) {
		const { value, done } = await reader.read()
		if (done) return
		buffer += decoder.decode(value, { stream: true })
		const frames = buffer.split("\n\n")
		buffer = frames.pop() ?? ""
		for (const frame of frames) {
			const dataLine = frame.split("\n").find((line) => line.startsWith("data:"))
			if (!dataLine) continue
			const event = parseChatEvent(dataLine.slice(5).trim())
			if (event && dispatchEvent(event, callbacks)) return
		}
	}
}

const turnEndErrorText = (event: ChatTurnEndEvent): string => event.error ?? "Turn failed"

/** Map one `ChatEvent` onto the reducer callbacks. Returns true to stop (turn ended). */
function dispatchEvent(event: ChatEvent, cb: ChatStreamCallbacks): boolean {
	switch (event.type) {
		case "user-message":
			// The optimistic send already rendered this locally (see
			// `use-mobile-chat.ts`'s `sendMessage`); nothing new to show.
			return false
		case "turn-start":
			cb.onAssistantStart?.(event.messageId)
			return false
		case "text-delta":
			cb.onTextDelta?.(-1, event.text)
			return false
		case "tool-call":
			// Maple delivers tool input complete (no streaming) → input-available.
			cb.onToolInputAvailable?.(event.callId, event.name, event.input)
			return false
		case "tool-result":
			if (event.isError) cb.onToolError?.(event.callId, errorText(event.output))
			else cb.onToolOutputAvailable?.(event.callId, event.output)
			return false
		case "turn-end":
			if (event.reason === "error") cb.onError?.(turnEndErrorText(event))
			return true
	}
}
