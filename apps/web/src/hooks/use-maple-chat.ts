import { useCallback, useEffect, useRef, useState } from "react"
import { Schema } from "effect"
import {
	ChatHistoryResponse,
	ChatSendResponse,
	decodeChatEvent,
	makeChatSessionId,
	type ChatEvent,
	type ChatMessage as ChatSessionMessage,
	type ChatToolCall,
} from "@maple/domain/chat-session"
import type { ChatStatus, UIMessage, UIMessagePart } from "@/components/ai-elements/types"
import {
	buildContextPreamble,
	wrapContextPreamble,
	type ChatContext,
} from "@/components/chat/context-preamble"
import { apiBaseUrl } from "@/lib/services/common/api-base-url"
import { getMapleAuthHeaders } from "@/lib/services/common/auth-headers"
import { tracedFetch } from "@/lib/services/common/telemetry"
import { useMapleOrganizationId } from "./use-maple-organization"

export interface UseMapleChatOptions {
	tabId: string
	/**
	 * Per-conversation context folded into the first message preamble. Omit for a
	 * conversation the server already seeded with its own context — an
	 * investigation's autonomous pass carries the subject snapshot server-side, so
	 * attaching it again would duplicate it into the model's window.
	 */
	context?: ChatContext
}

/**
 * A send that never reached the server. Mirrors the shape `@flue/react` used to
 * hand back so `chat-conversation.tsx`'s retry notice needs no changes: `id` is
 * the local id the optimistic message kept in `messages` (see `sendMessage`),
 * `message` is the raw text the user typed (not the preamble-wrapped text that
 * was actually posted, so a retry re-derives the preamble against the current
 * conversation state rather than replaying a stale one).
 */
export interface FailedSend {
	id: string
	message: string
	error: Error
}

export interface UseMapleChatResult {
	messages: UIMessage[]
	status: ChatStatus
	error: Error | undefined
	isLoading: boolean
	/** False until the durable history for this conversation has been read. */
	historyReady: boolean
	/** Sends that never reached the server; their optimistic message is still rendered. */
	failedSends: FailedSend[]
	sendMessage: (text: string) => void
	/** Aborts the running turn and everything queued behind it. */
	stop: () => void
	/** True while a turn is running and can be stopped. */
	canStop: boolean
}

const decodeHistory = Schema.decodeUnknownSync(ChatHistoryResponse)
const decodeSendResponse = Schema.decodeUnknownSync(ChatSendResponse)

const sessionUrl = (sessionId: string, suffix: string): string =>
	`${apiBaseUrl}/api/chat/sessions/${encodeURIComponent(sessionId)}${suffix}`

/** Attach the current Clerk/self-hosted bearer to a request init, same as every
 * other hand-rolled `fetch` in the app (see `mapleShapeFetch` in `shape-fetch.ts`). */
const authedInit = async (init: RequestInit): Promise<RequestInit> => {
	const authHeaders = await getMapleAuthHeaders()
	return { ...init, headers: { ...authHeaders, ...init.headers } }
}

/** Stringify a tool's error output for the `errorText` a card renders. */
const errorTextOf = (output: unknown): string => {
	if (typeof output === "string") return output
	try {
		return JSON.stringify(output)
	} catch {
		return String(output)
	}
}

function toolCallToPart(call: ChatToolCall): UIMessagePart {
	if (call.output === undefined) {
		return {
			type: "dynamic-tool",
			toolCallId: call.id,
			toolName: call.name,
			state: "input-available",
			input: call.input,
		}
	}
	if (call.isError) {
		return {
			type: "dynamic-tool",
			toolCallId: call.id,
			toolName: call.name,
			state: "output-error",
			input: call.input,
			errorText: errorTextOf(call.output),
		}
	}
	return {
		type: "dynamic-tool",
		toolCallId: call.id,
		toolName: call.name,
		state: "output-available",
		input: call.input,
		output: call.output,
	}
}

/**
 * A materialized `ChatMessage` → `UIMessage`. Text and tool calls arrive as two
 * separate fields on the wire (`ChatMessage` doesn't record how they were
 * interleaved live), so a cold-loaded turn always renders as prose followed by
 * the tool calls it made — the same shape a merged tool-only run collapses to
 * anyway once it's read back (see `chat-transcript.tsx`'s `buildTranscriptRows`).
 */
function historyMessageToUIMessage(message: ChatSessionMessage): UIMessage {
	const parts: UIMessagePart[] = []
	if (message.text) parts.push({ type: "text", text: message.text, state: "done" })
	for (const call of message.toolCalls) parts.push(toolCallToPart(call))
	return { id: message.id, role: message.role, parts }
}

function ensureAssistantMessage(messages: UIMessage[], messageId: string): UIMessage[] {
	if (messages.some((m) => m.id === messageId)) return messages
	return [...messages, { id: messageId, role: "assistant", parts: [] }]
}

function updateMessage(
	messages: UIMessage[],
	messageId: string,
	update: (message: UIMessage) => UIMessage,
): UIMessage[] {
	return messages.map((m) => (m.id === messageId ? update(m) : m))
}

/** Append (or continue) a streamed text delta. A trailing `streaming` text part
 * absorbs the delta; anything else — a tool call, or nothing yet — starts a new one. */
function appendTextDelta(message: UIMessage, delta: string): UIMessage {
	const last = message.parts[message.parts.length - 1]
	if (last && last.type === "text" && last.state === "streaming") {
		const parts = message.parts.slice(0, -1)
		parts.push({ type: "text", text: last.text + delta, state: "streaming" })
		return { ...message, parts }
	}
	return { ...message, parts: [...message.parts, { type: "text", text: delta, state: "streaming" }] }
}

/** Close out a trailing `streaming` text part so the thinking indicator doesn't
 * linger once a tool call — or the turn itself — interrupts it. */
function finalizeStreamingText(message: UIMessage): UIMessage {
	const last = message.parts[message.parts.length - 1]
	if (!last || last.type !== "text" || last.state !== "streaming") return message
	const parts = message.parts.slice(0, -1)
	parts.push({ ...last, state: "done" })
	return { ...message, parts }
}

function addToolCall(message: UIMessage, event: Extract<ChatEvent, { type: "tool-call" }>): UIMessage {
	const finalized = finalizeStreamingText(message)
	const part: UIMessagePart = {
		type: "dynamic-tool",
		toolCallId: event.callId,
		toolName: event.name,
		state: "input-available",
		input: event.input,
	}
	return { ...finalized, parts: [...finalized.parts, part] }
}

function settleToolCall(message: UIMessage, event: Extract<ChatEvent, { type: "tool-result" }>): UIMessage {
	const parts = message.parts.map((part): UIMessagePart => {
		if (part.type !== "dynamic-tool" || part.toolCallId !== event.callId) return part
		if (event.isError) {
			return {
				type: "dynamic-tool",
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				state: "output-error",
				input: part.input,
				errorText: errorTextOf(event.output),
			}
		}
		return {
			type: "dynamic-tool",
			toolCallId: part.toolCallId,
			toolName: part.toolName,
			state: "output-available",
			input: part.input,
			output: event.output,
		}
	})
	return { ...message, parts }
}

/**
 * Fold one live `ChatEvent` into the transcript. `user-message` is a no-op: the
 * optimistic send already rendered it under the same id the server assigns (see
 * `sendMessage`), so replaying it here would either duplicate it or land on a
 * message that's already there — either way there's nothing new to show.
 */
function applyChatEvent(messages: UIMessage[], event: ChatEvent): UIMessage[] {
	switch (event.type) {
		case "user-message":
			return messages
		case "turn-start":
			return ensureAssistantMessage(messages, event.messageId)
		case "text-delta": {
			const withMessage = ensureAssistantMessage(messages, event.messageId)
			return updateMessage(withMessage, event.messageId, (m) => appendTextDelta(m, event.text))
		}
		case "tool-call": {
			const withMessage = ensureAssistantMessage(messages, event.messageId)
			return updateMessage(withMessage, event.messageId, (m) => addToolCall(m, event))
		}
		case "tool-result":
			return updateMessage(messages, event.messageId, (m) => settleToolCall(m, event))
		case "turn-end":
			return updateMessage(messages, event.messageId, finalizeStreamingText)
	}
}

/** Reconnect budget for a dropped `events` stream before surfacing an error. */
const MAX_STREAM_RETRIES = 3

/**
 * Rewrite of the Flue-backed `useFlueChat` against Maple's own durable chat
 * transport (`packages/domain/src/chat-session.ts`). Addresses
 * `<orgId>:<tabId>` on the Maple API, POSTs a send, then tails
 * `GET .../events?cursor=` — an `EventSource` can't carry the Authorization
 * header this needs, so the stream is a plain `fetch` read manually as SSE
 * frames, decoded with `decodeChatEvent`.
 *
 * The transcript is entirely server-owned: the API records the submitted prompt
 * as a durable `user-message` event, so both roles replay on any device. A
 * cold-loaded conversation with a turn in flight (`history.running`) resumes the
 * live tail from `history.cursor` instead of waiting for the next send.
 */
export function useMapleChat({ tabId, context }: UseMapleChatOptions): UseMapleChatResult {
	const orgId = useMapleOrganizationId()
	const sessionId = orgId ? makeChatSessionId(orgId, tabId) : undefined

	const [messages, setMessages] = useState<UIMessage[]>([])
	const [status, setStatus] = useState<ChatStatus>("ready")
	const [error, setError] = useState<Error | undefined>(undefined)
	const [historyReady, setHistoryReady] = useState(false)
	const [failedSends, setFailedSends] = useState<FailedSend[]>([])

	const abortRef = useRef<AbortController | undefined>(undefined)
	const lastSeqRef = useRef(0)

	const stopStream = useCallback(() => {
		abortRef.current?.abort()
		abortRef.current = undefined
	}, [])

	// Read the durable event stream from `cursor`, folding every frame into the
	// transcript until the turn ends, the caller stops it, or the connection drops
	// for good. A dropped connection resumes from `lastSeqRef` — the whole point of
	// the server assigning a monotonic seq to every event — instead of replaying
	// (and re-animating) the turn from the start.
	const runStream = useCallback(async (session: string, cursor: number) => {
		lastSeqRef.current = cursor
		for (let attempt = 0; ; attempt++) {
			const controller = new AbortController()
			abortRef.current = controller
			try {
				const init = await authedInit({ signal: controller.signal })
				const response = await tracedFetch(
					"maple-api",
					sessionUrl(session, `/events?cursor=${lastSeqRef.current}`),
					init,
				)
				if (!response.ok || !response.body) {
					throw new Error(`Chat stream request failed: ${response.status}`)
				}

				const reader = response.body.getReader()
				const decoder = new TextDecoder()
				let buffer = ""

				readLoop: while (true) {
					const { value, done } = await reader.read()
					if (done) break
					buffer += decoder.decode(value, { stream: true })
					const frames = buffer.split("\n\n")
					buffer = frames.pop() ?? ""
					for (const frame of frames) {
						const dataLine = frame.split("\n").find((line) => line.startsWith("data:"))
						if (!dataLine) continue
						const event = decodeChatEvent(dataLine.slice(5).trim())
						lastSeqRef.current = event.seq
						setMessages((prev) => applyChatEvent(prev, event))
						if (event.type === "turn-start") setStatus("streaming")
						if (event.type === "turn-end") {
							if (event.reason === "error") {
								setStatus("error")
								setError(new Error(event.error ?? "The chat turn failed."))
							} else {
								setStatus("ready")
							}
							break readLoop
						}
					}
				}
				return
			} catch (cause) {
				// `controller.abort()` from `stop()` or a session switch — not a failure.
				if (controller.signal.aborted) return
				if (attempt >= MAX_STREAM_RETRIES) {
					setStatus("error")
					setError(cause instanceof Error ? cause : new Error("Lost connection to chat."))
					return
				}
				await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
			}
		}
	}, [])

	// Cold-load history whenever the addressed conversation changes, and resume
	// the live tail if a turn was already running when this device connected.
	useEffect(() => {
		if (!sessionId) return
		let cancelled = false
		setHistoryReady(false)
		setMessages([])
		setFailedSends([])
		setError(undefined)
		setStatus("ready")
		stopStream()

		void (async () => {
			try {
				const init = await authedInit({})
				const response = await tracedFetch("maple-api", sessionUrl(sessionId, "/history"), init)
				if (!response.ok) throw new Error(`Failed to load chat history: ${response.status}`)
				const json: unknown = await response.json()
				const history = decodeHistory(json)
				if (cancelled) return
				setMessages(history.messages.map(historyMessageToUIMessage))
				setHistoryReady(true)
				if (history.running) {
					setStatus("streaming")
					void runStream(sessionId, history.cursor)
				}
			} catch (cause) {
				if (cancelled) return
				setHistoryReady(true)
				setError(cause instanceof Error ? cause : new Error("Failed to load chat history."))
			}
		})()

		return () => {
			cancelled = true
			stopStream()
		}
	}, [sessionId, runStream, stopStream])

	const sendMessage = useCallback(
		(text: string) => {
			const trimmed = text.trim()
			if (!trimmed || !sessionId) return

			// Only the first message of a fresh conversation carries the context preamble.
			const isFirst = messages.length === 0
			const block = isFirst && context ? buildContextPreamble(context) : ""
			const outgoing = block ? wrapContextPreamble(block, trimmed) : trimmed

			const localId = `local-${crypto.randomUUID()}`
			setMessages((prev) => [
				...prev,
				{ id: localId, role: "user", parts: [{ type: "text", text: outgoing, state: "done" }] },
			])
			setStatus("submitted")
			setError(undefined)

			void (async () => {
				try {
					const init = await authedInit({
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ text: outgoing }),
					})
					const response = await tracedFetch("maple-api", sessionUrl(sessionId, "/messages"), init)
					if (!response.ok) throw new Error(`Failed to send message: ${response.status}`)
					const json: unknown = await response.json()
					const sent = decodeSendResponse(json)
					// The server's id replaces the local optimistic one so the eventual
					// `user-message` event (same id) reconciles as a no-op.
					setMessages((prev) =>
						prev.map((m) => (m.id === localId ? { ...m, id: sent.messageId } : m)),
					)
					await runStream(sessionId, sent.cursor)
				} catch (cause) {
					setStatus("ready")
					setFailedSends((prev) => [
						...prev,
						{
							id: localId,
							message: trimmed,
							error: cause instanceof Error ? cause : new Error("Failed to send message."),
						},
					])
				}
			})()
		},
		[sessionId, messages.length, context, runStream],
	)

	const stop = useCallback(() => {
		if (!sessionId) return
		stopStream()
		setStatus("ready")
		void (async () => {
			try {
				const init = await authedInit({ method: "POST" })
				await tracedFetch("maple-api", sessionUrl(sessionId, "/abort"), init)
			} catch {
				// Best-effort cancel: the turn settles on its own if the abort never
				// lands, and a toast per failed cancel would be noise.
			}
		})()
	}, [sessionId, stopStream])

	const isLoading = status === "submitted" || status === "streaming"

	return {
		messages,
		status,
		error,
		isLoading,
		historyReady,
		failedSends,
		sendMessage,
		stop,
		canStop: isLoading,
	}
}
