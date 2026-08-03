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
	onToolInputAvailable?: (
		toolCallId: string,
		toolName: string,
		input: unknown,
		/** Approval-gated: the tool did not run and no result is coming. */
		proposed?: boolean,
	) => void
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
			let cursor = sent.cursor
			// Reconnect until the turn actually ends. The server recycles the connection after its
			// tail window elapses, so a clean EOF is NOT the end of the turn — treating it as one
			// truncated the transcript and settled the composer on any turn that went quiet for
			// 25s, which one slow tool call is enough to do. The cursor is what makes resuming
			// exact rather than a replay.
			for (;;) {
				const response = await client.openEventStream(sessionId, cursor, controller.signal)
				if (!response.ok || !response.body) {
					throw new Error(`Chat stream request failed: ${response.status}`)
				}
				const outcome = await readEventStream(response.body, callbacks, cursor)
				if (outcome.ended || controller.signal.aborted) break
				cursor = outcome.cursor
			}
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
 * Read `data:` frames off the durable event stream until `turn-end` or the connection closes.
 *
 * Reports which of the two happened, plus the last seq seen, so the caller can resume: a close
 * without `turn-end` means the server recycled the connection, not that the turn is over.
 */
async function readEventStream(
	body: ReadableStream<Uint8Array>,
	callbacks: ChatStreamCallbacks,
	startCursor: number,
): Promise<{ ended: boolean; cursor: number }> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ""
	let cursor = startCursor

	try {
		while (true) {
			const { value, done } = await reader.read()
			if (done) return { ended: false, cursor }
			buffer += decoder.decode(value, { stream: true })
			const frames = buffer.split("\n\n")
			buffer = frames.pop() ?? ""
			for (const frame of frames) {
				// SSE allows a payload to span several `data:` lines; reading only the first
				// silently truncated any frame that wrapped.
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n")
				if (!data) continue
				const event = parseChatEvent(data)
				if (!event) continue
				cursor = event.seq
				if (dispatchEvent(event, callbacks)) return { ended: true, cursor }
			}
		}
	} finally {
		// Releasing the reader is what lets the connection close; without it a turn that ended
		// while the server still had bytes to write left the socket pinned.
		await reader.cancel().catch(() => undefined)
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
			// `proposed` means the turn stopped on an approval-gated tool that did NOT run, so no
			// result is coming; surfacing it lets the UI say so instead of showing a tool that
			// appears to be running forever.
			cb.onToolInputAvailable?.(event.callId, event.name, event.input, event.proposed === true)
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
