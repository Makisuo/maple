// Streams a single chat turn from the Maple chat-agent Worker and parses the
// Vercel AI SDK v6 UI message stream (SSE) into UIMessage-part updates.
//
// Relies on `expo/fetch` so the response body can be read as a ReadableStream
// on iOS/Android (RN's built-in fetch cannot).

import { fetch as expoFetch } from "expo/fetch"
import type { AlertContext } from "./alert-context"
import { mobileChatUrl } from "./chat-agent-url"

type StreamChunk = Record<string, unknown> & { type: string }

export interface ChatStreamBody {
	orgId: string
	userText: string
	mode?: "alert" | "dashboard_builder"
	alertContext?: AlertContext
}

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

export function streamChat(
	threadId: string,
	body: ChatStreamBody,
	callbacks: ChatStreamCallbacks,
): StreamController {
	const controller = new AbortController()

	const completion = (async () => {
		let response: Response
		try {
			response = (await expoFetch(mobileChatUrl(threadId), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: controller.signal,
			})) as unknown as Response
		} catch (err) {
			if ((err as Error)?.name === "AbortError") return
			callbacks.onError?.(err instanceof Error ? err.message : String(err))
			return
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "")
			callbacks.onError?.(`chat-agent ${response.status}: ${text || response.statusText}`)
			return
		}

		const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader()
		if (!reader) {
			callbacks.onError?.("No response body from chat-agent")
			return
		}

		const decoder = new TextDecoder()
		let buffer = ""

		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })

				let idx: number
				while ((idx = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, idx).replace(/\r$/, "")
					buffer = buffer.slice(idx + 1)
					if (!line.startsWith("data:")) continue
					const payload = line.slice(5).trim()
					if (!payload || payload === "[DONE]") continue
					try {
						const chunk = JSON.parse(payload) as StreamChunk
						dispatchChunk(chunk, callbacks)
					} catch {
						// malformed chunk — skip
					}
				}
			}
		} catch (err) {
			if ((err as Error)?.name !== "AbortError") {
				callbacks.onError?.(err instanceof Error ? err.message : String(err))
			}
		} finally {
			callbacks.onDone?.()
		}
	})()

	return {
		abort: () => controller.abort(),
		completion,
	}
}

function dispatchChunk(chunk: StreamChunk, cb: ChatStreamCallbacks): void {
	const type = chunk.type
	switch (type) {
		case "start": {
			const id = typeof chunk.messageId === "string" ? chunk.messageId : ""
			cb.onAssistantStart?.(id || `msg-${Date.now()}`)
			return
		}
		case "text-start":
		case "text-end":
			return
		case "text-delta": {
			const delta = typeof chunk.delta === "string" ? chunk.delta : ""
			const id = typeof chunk.id === "string" ? chunk.id : undefined
			if (delta) cb.onTextDelta?.(-1, delta, id)
			return
		}
		case "tool-input-start": {
			const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : ""
			const toolName = typeof chunk.toolName === "string" ? chunk.toolName : "tool"
			if (toolCallId) cb.onToolInputStart?.(toolCallId, toolName)
			return
		}
		case "tool-input-available": {
			const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : ""
			const toolName = typeof chunk.toolName === "string" ? chunk.toolName : "tool"
			if (toolCallId) cb.onToolInputAvailable?.(toolCallId, toolName, chunk.input)
			return
		}
		case "tool-output-available": {
			const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : ""
			if (toolCallId) cb.onToolOutputAvailable?.(toolCallId, chunk.output)
			return
		}
		case "tool-output-error":
		case "tool-error": {
			const toolCallId = typeof chunk.toolCallId === "string" ? chunk.toolCallId : ""
			const errText = typeof chunk.errorText === "string" ? chunk.errorText : "Tool error"
			if (toolCallId) cb.onToolError?.(toolCallId, errText)
			return
		}
		case "error": {
			const errText = typeof chunk.errorText === "string" ? chunk.errorText : "Unknown error"
			cb.onError?.(errText)
			return
		}
		default:
			return
	}
}

