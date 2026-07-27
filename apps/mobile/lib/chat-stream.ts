// Streams a single chat turn from the Flue chat backend (`apps/chat-flue`) via
// `@flue/sdk`: `agents.send` admits the prompt, then `agents.stream` tails the
// agent's events from that prompt's offset until `idle`. The Flue events are
// mapped onto the same callbacks the mobile reducer consumes, so the message
// rendering is unchanged from the legacy SSE transport.
//
// NOTE: this app is deliberately pinned to `@flue/sdk@1.0.0-beta.1` while the
// web and the worker run beta.9. beta.9 dropped `agents.stream` in favour of
// `agents.observe`, which hands back a materialized conversation to subscribe
// to rather than a stream of deltas — a different shape from the reducer below,
// so adopting it is a rewrite of this file and its consumer, and one that can
// only be validated on a device. The wire format is unchanged (the worker still
// serves the durable event stream, and every variant this switch handles still
// exists in beta.9), so the pin is safe until that migration happens.

import type { AttachedAgentEvent, FlueClient } from "@flue/sdk"

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
	client: FlueClient
	/** Flue agent module name (`maple-chat`). */
	agentName: string
	/** Agent instance id (`<orgId>:<threadId>`). */
	instanceId: string
	/** The full message string to send (context preamble already folded in). */
	message: string
	callbacks: ChatStreamCallbacks
}

const isAbort = (err: unknown): boolean => (err as Error)?.name === "AbortError"

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

export function streamChat({
	client,
	agentName,
	instanceId,
	message,
	callbacks,
}: StreamChatOptions): StreamController {
	const controller = new AbortController()

	const completion = (async () => {
		try {
			const sent = await client.agents.send(agentName, instanceId, {
				message,
				signal: controller.signal,
			})

			for await (const event of client.agents.stream(agentName, instanceId, {
				offset: sent.offset,
				live: true,
				signal: controller.signal,
			})) {
				if (dispatchEvent(event, callbacks)) break
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
		abort: () => controller.abort(),
		completion,
	}
}

/** Map one Flue agent event onto the reducer callbacks. Returns true to stop (turn idle). */
function dispatchEvent(event: AttachedAgentEvent, cb: ChatStreamCallbacks): boolean {
	switch (event.type) {
		case "message_start": {
			// Open an assistant bubble as soon as the model turn begins (covers
			// tool-first turns that emit no leading text delta).
			if (event.message.role === "assistant") {
				cb.onAssistantStart?.(event.turnId ?? `asst-${event.eventIndex}`)
			}
			return false
		}
		case "text_delta": {
			if (event.text) cb.onTextDelta?.(-1, event.text)
			return false
		}
		case "tool_start": {
			// Flue delivers tool input complete (no streaming) → input-available.
			cb.onToolInputAvailable?.(event.toolCallId, event.toolName, event.args)
			return false
		}
		case "tool": {
			if (event.isError) cb.onToolError?.(event.toolCallId, errorText(event.result))
			else cb.onToolOutputAvailable?.(event.toolCallId, event.result)
			return false
		}
		case "turn": {
			if (event.isError) cb.onError?.(errorText(event.error))
			return false
		}
		case "submission_settled": {
			if (event.outcome === "failed") cb.onError?.(event.error ?? "Turn failed")
			return true
		}
		case "idle":
			return true
		default:
			return false
	}
}
