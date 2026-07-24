import { useCallback, useEffect, useMemo, useState } from "react"
import { useFlueAgent, type AgentStatus, type UIMessage } from "@flue/react"
import type { ChatStatus } from "@/components/ai-elements/types"
import {
	buildContextPreamble,
	wrapContextPreamble,
	type ChatContext,
} from "@/components/chat/context-preamble"
import { loadUserLog, mergeUserMessages, saveUserLog, type UserLogEntry } from "./flue-user-log"
import { useMapleOrganizationId } from "./use-maple-organization"

const AGENT_NAME = "maple-chat"

export interface UseFlueChatOptions {
	tabId: string
	/** Per-conversation context folded into the first message preamble. */
	context?: ChatContext
}

export interface UseFlueChatResult {
	messages: UIMessage[]
	status: ChatStatus
	error: Error | undefined
	isLoading: boolean
	sendMessage: (text: string) => void
}

/** Flue's `idle`/`connecting` have no composer equivalent — treat them as ready. */
const toChatStatus = (status: AgentStatus): ChatStatus => {
	switch (status) {
		case "submitted":
			return "submitted"
		case "streaming":
			return "streaming"
		case "error":
			return "error"
		default:
			return "ready"
	}
}

/**
 * Thin adapter over `useFlueAgent` exposing the surface `chat-conversation.tsx`
 * consumes. Addresses the org-scoped `maple-chat/<orgId>:<tabId>` agent,
 * reconstructs full history, maps status for the composer, and attaches the
 * per-conversation context preamble to the first message.
 *
 * The deployed Flue runtime never emits the user's own message into the durable
 * event stream, so `useFlueAgent`'s optimistic user bubble vanishes the moment the
 * assistant turn starts (see {@link mergeUserMessages}). We therefore own the user's
 * messages here: persist each sent message (clean text + an assistant-turn anchor)
 * and merge them back into the rendered transcript.
 */
export function useFlueChat({ tabId, context }: UseFlueChatOptions): UseFlueChatResult {
	const orgId = useMapleOrganizationId()
	const conversationId = orgId ? `${orgId}:${tabId}` : undefined
	const agent = useFlueAgent({ name: AGENT_NAME, id: conversationId, history: "all" })

	// Client-owned user messages (Flue never streams them back). Reload from storage
	// whenever the addressed conversation changes.
	const [userLog, setUserLog] = useState<UserLogEntry[]>(() => loadUserLog(conversationId))
	useEffect(() => {
		setUserLog(loadUserLog(conversationId))
	}, [conversationId])

	const messages = useMemo(() => mergeUserMessages(agent.messages, userLog), [agent.messages, userLog])

	// On a fresh (dormant) conversation, the first send schedules a stream reconnect,
	// so Flue flips to `connecting` while the backend cold-starts — which the SDK does
	// not count as activity. Track that we're awaiting a reply so the "Thinking…"
	// indicator (and the disabled composer) survive that gap. Cleared when the turn
	// settles; kept through mid-stream reconnect blips by not clearing on `streaming`.
	const [pendingResponse, setPendingResponse] = useState(false)
	useEffect(() => {
		setPendingResponse(false)
	}, [conversationId])
	useEffect(() => {
		if (agent.status === "idle" || agent.status === "error") setPendingResponse(false)
	}, [agent.status])

	const isLoading =
		agent.status === "submitted" ||
		agent.status === "streaming" ||
		(pendingResponse && agent.status === "connecting")

	const sendMessage = useCallback(
		(text: string) => {
			const trimmed = text.trim()
			if (!trimmed || !conversationId) return
			// Only the first message of a fresh conversation carries the context preamble.
			const isFirst = agent.messages.length === 0 && userLog.length === 0
			const block = isFirst && context ? buildContextPreamble(context) : ""
			const outgoing = block ? wrapContextPreamble(block, trimmed) : trimmed
			// Anchor this message before the assistant turn(s) it will trigger.
			const turnsBefore = agent.messages.filter((message) => message.role === "assistant").length
			setPendingResponse(true)
			setUserLog((prev) => {
				const next: UserLogEntry[] = [
					...prev,
					{ id: `${conversationId}:user:${prev.length}`, text: trimmed, turnsBefore },
				]
				saveUserLog(conversationId, next)
				return next
			})
			void agent.sendMessage(outgoing)
		},
		[agent, context, conversationId, userLog.length],
	)

	return {
		messages,
		status: toChatStatus(agent.status),
		error: agent.error,
		isLoading,
		sendMessage,
	}
}
