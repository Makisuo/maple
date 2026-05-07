import { useCallback, useEffect, useRef, useState } from "react"
import { useAuth } from "@clerk/expo"
import type { UIMessage } from "ai"
import type { AlertContext } from "../lib/alert-context"
import {
	loadMessages,
	previewFromMessage,
	saveMessages,
	titleFromFirstUserText,
	upsertThread,
} from "../lib/chat-threads"
import { streamChat } from "../lib/chat-stream"

type Status = "idle" | "submitted" | "streaming" | "error"

interface UseMobileChatOptions {
	threadId: string
	alertContext?: AlertContext
}

interface ToolPart {
	type: string
	toolCallId: string
	toolName?: string
	state: "input-streaming" | "input-available" | "output-available" | "output-error"
	input?: unknown
	output?: unknown
	errorText?: string
}

function makeId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export function useMobileChat({ threadId, alertContext }: UseMobileChatOptions) {
	const { orgId, getToken } = useAuth()
	const [messages, setMessages] = useState<UIMessage[]>([])
	const [status, setStatus] = useState<Status>("idle")
	const [error, setError] = useState<string | null>(null)
	const [hydrated, setHydrated] = useState(false)
	const activeStream = useRef<{ abort: () => void } | null>(null)
	const assistantIdRef = useRef<string | null>(null)

	useEffect(() => {
		let cancelled = false
		void loadMessages(threadId).then((persisted) => {
			if (cancelled) return
			setMessages(persisted)
			setHydrated(true)
		})
		return () => {
			cancelled = true
			activeStream.current?.abort()
		}
	}, [threadId])

	const persist = useCallback(
		(next: UIMessage[]) => {
			void saveMessages(threadId, next)
		},
		[threadId],
	)

	const updateSummary = useCallback(
		(firstUserText: string, lastMessage: UIMessage | undefined) => {
			void upsertThread({
				threadId,
				title: titleFromFirstUserText(firstUserText),
				lastMessagePreview: previewFromMessage(lastMessage),
				lastMessageAt: Date.now(),
				alertContext,
			})
		},
		[threadId, alertContext],
	)

	const sendMessage = useCallback(
		(text: string) => {
			if (!orgId) {
				setError("No organization — sign in first")
				return
			}
			const userText = text.trim()
			if (!userText) return
			if (status === "submitted" || status === "streaming") return

			setError(null)
			const userMsg: UIMessage = {
				id: makeId("user"),
				role: "user",
				parts: [{ type: "text", text: userText } as UIMessage["parts"][number]],
			}

			setMessages((prev) => {
				const next = [...prev, userMsg]
				persist(next)
				const firstUserText =
					(
						next.find((m) => m.role === "user")?.parts.find((p) => p.type === "text") as
							| { type: "text"; text: string }
							| undefined
					)?.text ?? userText
				updateSummary(firstUserText, userMsg)
				return next
			})
			setStatus("submitted")

			assistantIdRef.current = null

			const stream = streamChat({
				threadId,
				body: {
					orgId,
					userText,
					mode: alertContext ? "alert" : undefined,
					alertContext,
				},
				getToken,
				callbacks: {
					onAssistantStart: (id) => {
						const assistantId = id || makeId("asst")
						assistantIdRef.current = assistantId
						setMessages((prev) => [
							...prev,
							{ id: assistantId, role: "assistant", parts: [] } as UIMessage,
						])
						setStatus("streaming")
					},
					onTextDelta: (_idx, delta) => {
						if (!assistantIdRef.current) {
							assistantIdRef.current = makeId("asst")
							setMessages((prev) => [
								...prev,
								{
									id: assistantIdRef.current as string,
									role: "assistant",
									parts: [{ type: "text", text: delta } as UIMessage["parts"][number]],
								} as UIMessage,
							])
							setStatus("streaming")
							return
						}
						setMessages((prev) => updateLastAssistant(prev, (msg) => appendTextDelta(msg, delta)))
					},
					onToolInputStart: (toolCallId, toolName) => {
						setMessages((prev) =>
							updateLastAssistant(prev, (msg) =>
								addOrUpdateToolPart(msg, toolCallId, toolName, "input-streaming"),
							),
						)
					},
					onToolInputAvailable: (toolCallId, toolName, input) => {
						setMessages((prev) =>
							updateLastAssistant(prev, (msg) =>
								addOrUpdateToolPart(msg, toolCallId, toolName, "input-available", { input }),
							),
						)
					},
					onToolOutputAvailable: (toolCallId, output) => {
						setMessages((prev) =>
							updateLastAssistant(prev, (msg) =>
								addOrUpdateToolPart(msg, toolCallId, undefined, "output-available", {
									output,
								}),
							),
						)
					},
					onToolError: (toolCallId, errorText) => {
						setMessages((prev) =>
							updateLastAssistant(prev, (msg) =>
								addOrUpdateToolPart(msg, toolCallId, undefined, "output-error", {
									errorText,
								}),
							),
						)
					},
					onError: (errText) => {
						setError(errText)
						setStatus("error")
					},
					onDone: () => {
						setStatus((s) => (s === "error" ? s : "idle"))
						activeStream.current = null
						setMessages((prev) => {
							persist(prev)
							const last = prev[prev.length - 1]
							void upsertThread({
								threadId,
								title: titleFromFirstUserText(userText),
								lastMessagePreview: previewFromMessage(last),
								lastMessageAt: Date.now(),
								alertContext,
							})
							return prev
						})
					},
				},
			})
			activeStream.current = stream
		},
		[orgId, status, threadId, alertContext, getToken, persist, updateSummary],
	)

	const stop = useCallback(() => {
		activeStream.current?.abort()
		activeStream.current = null
		setStatus("idle")
	}, [])

	return { messages, status, error, hydrated, sendMessage, stop }
}

function updateLastAssistant(messages: UIMessage[], updater: (msg: UIMessage) => UIMessage): UIMessage[] {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const m = messages[i]
		if (m.role === "assistant") {
			const next = [...messages]
			next[i] = updater(m)
			return next
		}
	}
	return messages
}

function appendTextDelta(msg: UIMessage, delta: string): UIMessage {
	const parts = [...msg.parts]
	const last = parts[parts.length - 1] as { type: string; text?: string } | undefined
	if (last && last.type === "text") {
		parts[parts.length - 1] = {
			...last,
			text: (last.text ?? "") + delta,
		} as UIMessage["parts"][number]
	} else {
		parts.push({ type: "text", text: delta } as UIMessage["parts"][number])
	}
	return { ...msg, parts }
}

function addOrUpdateToolPart(
	msg: UIMessage,
	toolCallId: string,
	toolName: string | undefined,
	state: ToolPart["state"],
	patch?: Partial<ToolPart>,
): UIMessage {
	const parts = [...msg.parts] as Array<UIMessage["parts"][number]>
	const idx = parts.findIndex((p) => {
		const asTool = p as unknown as ToolPart
		return asTool.toolCallId === toolCallId
	})
	if (idx >= 0) {
		const existing = parts[idx] as unknown as ToolPart
		const next: ToolPart = {
			...existing,
			toolName: toolName ?? existing.toolName,
			state,
			...patch,
		}
		parts[idx] = next as unknown as UIMessage["parts"][number]
	} else {
		const partType = toolName ? `tool-${toolName}` : "dynamic-tool"
		const tool: ToolPart = {
			type: partType,
			toolCallId,
			toolName,
			state,
			...patch,
		}
		parts.push(tool as unknown as UIMessage["parts"][number])
	}
	return { ...msg, parts }
}
