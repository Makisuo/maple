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
	/** `"<orgId>:<tabId>"`, or undefined before the org resolves. Callers that record something
	 * back into this conversation (an applied approval) need it. */
	sessionId: string | undefined
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
			// An approval-gated call never produces output, so on a cold load it is
			// indistinguishable from a pending one except by this flag. Without it a reloaded
			// conversation showed every past proposal as a tool stuck mid-flight.
			state: call.proposed === true ? "proposed" : "input-available",
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
		// `proposed` means the turn stopped here and the tool did NOT run; the transcript renders
		// an approval card rather than a running tool row, and no `tool-result` is coming.
		state: event.proposed === true ? "proposed" : "input-available",
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

/** Consecutive-failure budget for a dropped `events` stream before surfacing an error. */
const MAX_STREAM_RETRIES = 3

/**
 * Abortable delay. Resolves `true` if it ran to completion, `false` if the signal fired first.
 * A plain `setTimeout` promise cannot be interrupted, so a `stop()` landing inside a reconnect
 * backoff was ignored and the loop carried on afterwards with a fresh controller.
 */
const sleep = (ms: number, signal: AbortSignal): Promise<boolean> =>
	new Promise((resolve) => {
		if (signal.aborted) return resolve(false)
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort)
			resolve(true)
		}, ms)
		const onAbort = () => {
			clearTimeout(timer)
			resolve(false)
		}
		signal.addEventListener("abort", onAbort, { once: true })
	})

/**
 * A send the server refused because the conversation already has a turn in flight — a second tab,
 * or an investigation's autonomous pass. Worth its own sentence: the raw
 * `Failed to send message: 409` this used to surface in the destructive banner told the user
 * nothing about what to do.
 */
const TURN_IN_FLIGHT_MESSAGE =
	"This conversation already has a reply in progress. Wait for it to finish, or stop it first."

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

	// One record per live stream. A resumed tail (from `history.running`) and a tail opened by a
	// send can both be in flight, and a single shared controller/cursor pair meant the second
	// silently orphaned the first — never aborted, still writing into `setMessages` — while both
	// stomped on one cursor, so the next reconnect resumed from the wrong seq and replayed or
	// skipped events. Each stream now owns its cursor, and a generation counter tells a stream
	// whether it is still the current one.
	const streamRef = useRef<{ generation: number; controller: AbortController } | undefined>(undefined)
	const generationRef = useRef(0)
	/** Whether this conversation has any message yet, without making `messages` a dependency. */
	const hasMessagesRef = useRef(false)
	hasMessagesRef.current = messages.length > 0

	// Between the SSE reader and React: one commit per animation frame, not one per event.
	//
	// The reader used to call `setMessages` per frame and rely on React's automatic batching, which
	// only coalesces events that arrived inside a single `reader.read()` — so the commit rate was
	// whatever the network happened to deliver. Buffering here makes it the display's rate instead,
	// which is the most a reader can perceive and the ceiling the transcript render cost is worth
	// paying at.
	const pendingRef = useRef<ChatEvent[]>([])
	const flushHandleRef = useRef<number | undefined>(undefined)

	const flushEvents = useCallback(() => {
		flushHandleRef.current = undefined
		const batch = pendingRef.current
		if (batch.length === 0) return
		pendingRef.current = []
		setMessages((prev) => batch.reduce((acc, event) => applyChatEvent(acc, event), prev))
	}, [])

	/** Apply everything buffered right now, without waiting for a frame. */
	const flushEventsNow = useCallback(() => {
		if (flushHandleRef.current !== undefined) cancelAnimationFrame(flushHandleRef.current)
		flushEvents()
	}, [flushEvents])

	const enqueueEvent = useCallback(
		(event: ChatEvent) => {
			pendingRef.current.push(event)
			if (flushHandleRef.current !== undefined) return
			flushHandleRef.current = requestAnimationFrame(flushEvents)
		},
		[flushEvents],
	)

	const stopStream = useCallback(() => {
		generationRef.current += 1
		streamRef.current?.controller.abort()
		streamRef.current = undefined
		// Drop whatever the abandoned stream had buffered. Letting it flush would fold a previous
		// session's events into the transcript the next stream is building.
		if (flushHandleRef.current !== undefined) cancelAnimationFrame(flushHandleRef.current)
		flushHandleRef.current = undefined
		pendingRef.current = []
	}, [])

	// Read the durable event stream from `cursor`, folding every frame into the transcript until
	// the turn ends, the caller stops it, or the connection drops for good. A dropped connection
	// resumes from this stream's own cursor — the whole point of the server assigning a monotonic
	// seq to every event — instead of replaying (and re-animating) the turn from the start.
	const runStream = useCallback(
		async (session: string, cursor: number) => {
			const generation = (generationRef.current += 1)
			const isCurrent = () => generationRef.current === generation
			let seq = cursor
			// Consecutive failures, not cumulative: a reconnect that works resets the budget, so three
			// drops spread over a long turn no longer exhaust it as if they had been back to back.
			let consecutiveFailures = 0

			for (;;) {
				if (!isCurrent()) return
				const controller = new AbortController()
				streamRef.current = { generation, controller }
				let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
				try {
					const init = await authedInit({ signal: controller.signal })
					const response = await tracedFetch(
						"maple-api",
						sessionUrl(session, `/events?cursor=${seq}`),
						init,
					)
					if (!response.ok || !response.body) {
						throw new Error(`Chat stream request failed: ${response.status}`)
					}

					reader = response.body.getReader()
					const decoder = new TextDecoder()
					let buffer = ""
					let sawTurnEnd = false

					readLoop: while (true) {
						const { value, done } = await reader.read()
						if (done) break
						if (!isCurrent()) return
						buffer += decoder.decode(value, { stream: true })
						const frames = buffer.split("\n\n")
						buffer = frames.pop() ?? ""
						for (const frame of frames) {
							// SSE allows a payload to span several `data:` lines; joining them is the
							// spec's own rule, and reading only the first silently truncated any frame
							// that wrapped.
							const data = frame
								.split("\n")
								.filter((line) => line.startsWith("data:"))
								.map((line) => line.slice(5).trimStart())
								.join("\n")
							if (!data) continue
							// Unknown frames are skipped, not thrown on. Throwing here reconnected from
							// the cursor *before* the offending frame, so the server replayed it and the
							// client threw again until the retry budget ran out.
							const event = decodeChatEvent(data)
							if (!event) continue
							seq = event.seq
							enqueueEvent(event)
							if (event.type === "turn-start") setStatus("streaming")
							if (event.type === "turn-end") {
								sawTurnEnd = true
								// The turn is over, so there is no next frame to ride: apply the tail of
								// the answer now rather than leaving the last deltas buffered behind a
								// callback a backgrounded tab will not run.
								flushEventsNow()
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

					consecutiveFailures = 0
					// A clean EOF without a `turn-end` is the server recycling the connection after its
					// tail window elapsed, NOT the end of the turn. Treating it as the end left the
					// composer disabled forever on any turn that went quiet for 25s — one slow tool
					// call was enough. Reconnect from the cursor instead.
					if (sawTurnEnd) return
					if (!isCurrent()) return
					continue
				} catch (cause) {
					// `controller.abort()` from `stop()` or a session switch — not a failure.
					if (controller.signal.aborted || !isCurrent()) return
					consecutiveFailures += 1
					if (consecutiveFailures > MAX_STREAM_RETRIES) {
						setStatus("error")
						setError(cause instanceof Error ? cause : new Error("Lost connection to chat."))
						return
					}
					// Abortable: an unabortable sleep meant `stop()` (or an unmount) during a reconnect
					// window did nothing, and the loop went on to build a *fresh* controller and keep
					// streaming into a conversation the user had left.
					const settled = await sleep(300 * consecutiveFailures, controller.signal)
					if (!settled || !isCurrent()) return
				} finally {
					// Releasing the reader is what lets the connection close. Without it a turn that
					// ended while the server still had bytes to write left the body half-consumed and
					// the socket pinned.
					await reader?.cancel().catch(() => undefined)
				}
			}
		},
		[enqueueEvent, flushEventsNow],
	)

	// Cold-load history whenever the addressed conversation changes, and resume the live tail if a
	// turn was already running when this device connected.
	//
	// One of the few sanctioned `useEffect`s (see `.oxlintrc.json`'s `no-restricted-imports` rule):
	// it subscribes to an external system whose identity is a prop, so `useMountEffect` doesn't
	// cover it, and the history read is the same subscription's bootstrap rather than independent
	// data fetching — these routes are a raw `HttpRouter` (SSE), so they have no generated atom in
	// `MapleApiAtomClient` to fetch through. The state reset below is not a `key`-able concern
	// either, because the transcript component must keep its scroll position across a resume.
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
			// Read through a ref, not `messages.length`: as a dependency it rebuilt this callback on
			// every token delta, invalidating the handler identity down through the composer for the
			// whole stream. (The mobile hook already does it this way.)
			const isFirst = !hasMessagesRef.current
			const block = isFirst && context ? buildContextPreamble(context) : ""
			const outgoing = block ? wrapContextPreamble(block, trimmed) : trimmed

			const localId = `local-${crypto.randomUUID()}`
			setMessages((prev) => [
				...prev,
				{ id: localId, role: "user", parts: [{ type: "text", text: outgoing, state: "done" }] },
			])
			setStatus("submitted")
			setError(undefined)
			// A retry supersedes the banner from the previous attempt; leaving it up made
			// "Message not sent" permanent once shown, including after the resend worked.
			setFailedSends([])

			void (async () => {
				try {
					const init = await authedInit({
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ text: outgoing }),
					})
					const response = await tracedFetch("maple-api", sessionUrl(sessionId, "/messages"), init)
					if (response.status === 409) throw new Error(TURN_IN_FLIGHT_MESSAGE)
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
					// Drop the optimistic bubble along with the failure. Keeping it meant a retry
					// rendered the same message twice — and three times after a reload, if the POST
					// had reached the Durable Object before the response failed.
					setMessages((prev) => prev.filter((m) => m.id !== localId))
					setFailedSends([
						{
							id: localId,
							message: trimmed,
							error: cause instanceof Error ? cause : new Error("Failed to send message."),
						},
					])
				}
			})()
		},
		[sessionId, context, runStream],
	)

	const stop = useCallback(() => {
		if (!sessionId) return
		stopStream()
		setStatus("ready")
		// Close the open text part. Without this the last part stays `streaming`, so the thinking
		// indicator lingers on a turn the user just stopped.
		setMessages((prev) => prev.map(finalizeStreamingText))
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
		sessionId,
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
