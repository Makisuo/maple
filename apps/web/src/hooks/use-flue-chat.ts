import { useCallback, useMemo } from "react"
import { useFlueAgent, type AgentStatus, type FailedSend } from "@flue/react"
import type { ChatStatus, UIMessage } from "@/components/ai-elements/types"
import { createChatConversationClient } from "@/components/chat/chat-conversation-client"
import {
	buildContextPreamble,
	wrapContextPreamble,
	type ChatContext,
} from "@/components/chat/context-preamble"
import { useMapleOrganizationId } from "./use-maple-organization"

export interface UseFlueChatOptions {
	tabId: string
	/**
	 * Per-conversation context folded into the first message preamble. Omit for a
	 * conversation the server already seeded with its own context — an
	 * investigation's autonomous pass carries the subject snapshot server-side, so
	 * attaching it again would duplicate it into the model's window.
	 */
	context?: ChatContext
}

export interface UseFlueChatResult {
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
 * consumes. Addresses the org-scoped `maple-chat/<orgId>:<tabId>` agent, maps
 * status for the composer, and attaches the per-conversation context preamble to
 * the first message.
 *
 * The transcript is entirely server-owned: Flue records the submitted prompt as a
 * durable `user_message` in the conversation, so both roles replay on any device.
 * (An earlier runtime never emitted the user turn, which forced a localStorage
 * mirror here — that is gone, along with the turn-counting interleave it needed,
 * and the timer that guessed when history had settled.)
 */
export function useFlueChat({ tabId, context }: UseFlueChatOptions): UseFlueChatResult {
	const orgId = useMapleOrganizationId()
	const conversationId = orgId ? `${orgId}:${tabId}` : undefined
	// One client per conversation (Flue 2 has no deployment-wide client). Memoized
	// on the id because a new instance replaces the live session.
	const client = useMemo(
		() => (conversationId ? createChatConversationClient(conversationId) : undefined),
		[conversationId],
	)
	const agent = useFlueAgent({ client })

	const isLoading = agent.status === "submitted" || agent.status === "streaming"

	const sendMessage = useCallback(
		(text: string) => {
			const trimmed = text.trim()
			if (!trimmed || !conversationId) return
			// Only the first message of a fresh conversation carries the context preamble.
			const isFirst = agent.messages.length === 0
			const block = isFirst && context ? buildContextPreamble(context) : ""
			void agent.sendMessage(block ? wrapContextPreamble(block, trimmed) : trimmed)
		},
		[agent, context, conversationId],
	)

	const stop = useCallback(() => {
		void client?.abort().catch(() => {
			// Best-effort cancel: the turn settles on its own if the abort never
			// lands, and a toast per failed cancel would be noise.
		})
	}, [client])

	return {
		messages: agent.messages,
		status: toChatStatus(agent.status),
		error: agent.error,
		isLoading,
		historyReady: agent.historyReady,
		failedSends: agent.failedSends,
		sendMessage,
		stop,
		canStop: isLoading,
	}
}
