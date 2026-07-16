import { useCallback, useMemo, useState } from "react"
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
	responseSettled: boolean
	settleResponse: () => void
	sendMessage: (text: string) => void
}

export const isResponseSettled = (status: AgentStatus): boolean => status === "idle" || status === "error"

export const isFlueChatLoading = (status: AgentStatus, pendingResponse: boolean): boolean =>
	status === "submitted" || status === "streaming" || (pendingResponse && status === "connecting")

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

	// Keep the local override scoped to its conversation. When Clerk resolves an
	// org (or the addressed conversation changes), the persisted log is selected
	// directly instead of synchronizing mirrored state in an effect.
	const persistedUserLog = useMemo(() => loadUserLog(conversationId), [conversationId])
	const [userLogOverride, setUserLogOverride] = useState<{
		readonly conversationId: string | undefined
		readonly entries: UserLogEntry[]
	} | null>(null)
	const userLog =
		userLogOverride !== null && userLogOverride.conversationId === conversationId
			? userLogOverride.entries
			: persistedUserLog

	const messages = useMemo(() => mergeUserMessages(agent.messages, userLog), [agent.messages, userLog])
	const [pendingResponse, setPendingResponse] = useState(false)
	const responseSettled = isResponseSettled(agent.status)
	const settleResponse = useCallback(() => setPendingResponse(false), [])
	const isLoading = isFlueChatLoading(agent.status, pendingResponse)

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
			const next: UserLogEntry[] = [
				...userLog,
				{ id: `${conversationId}:user:${userLog.length}`, text: trimmed, turnsBefore },
			]
			saveUserLog(conversationId, next)
			setUserLogOverride({ conversationId, entries: next })
			setPendingResponse(true)
			void agent.sendMessage(outgoing)
		},
		[agent, context, conversationId, userLog],
	)

	return {
		messages,
		status: toChatStatus(agent.status),
		error: agent.error,
		isLoading,
		responseSettled,
		settleResponse,
		sendMessage,
	}
}
