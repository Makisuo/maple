import { useCallback, useEffect, useRef, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { useLiveQuery } from "@tanstack/react-db"
import { chatAgentUrl } from "@/lib/services/common/chat-agent-url"
import { useChatroom } from "@/hooks/use-chatroom"
import { useTypeAnywhereFocus } from "@/hooks/use-type-anywhere-focus"
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import { Message, MessageContent } from "@/components/ai-elements/message"
import { RichText } from "@/components/ai-elements/rich-text"
import {
	PromptInput,
	PromptInputTextarea,
	PromptInputFooter,
	PromptInputSubmit,
} from "@/components/ai-elements/prompt-input"
import { Suggestions, Suggestion } from "@/components/ai-elements/suggestion"
import { Shimmer } from "@/components/ai-elements/shimmer"

const DEFAULT_SUGGESTIONS = [
	"What's the overall system health?",
	"Show me the slowest traces",
	"Are there any errors right now?",
	"Which services have the highest error rate?",
]

interface ChatConversationProps {
	tabId: string
	isActive: boolean
	onFirstMessage?: (tabId: string, text: string) => void
}

export function ChatConversation({ tabId, isActive, onFirstMessage }: ChatConversationProps) {
	const { orgId, getToken } = useAuth()
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	useTypeAnywhereFocus(textareaRef, isActive)

	const [chatroomId, setChatroomId] = useState<string | null>(null)
	const [initError, setInitError] = useState<string | null>(null)
	const [isAwaitingReply, setIsAwaitingReply] = useState(false)

	const getTokenRef = useRef(getToken)
	useEffect(() => {
		getTokenRef.current = getToken
	}, [getToken])

	// Spawn the entity (idempotent) and learn its chatroomId. The chatroomId
	// is the shared-state stream the assistant + frontend both observe.
	useEffect(() => {
		if (!orgId) {
			setChatroomId(null)
			return
		}
		let cancelled = false
		setInitError(null)
		;(async () => {
			try {
				const token = await getTokenRef.current()
				const res = await fetch(
					`${chatAgentUrl}/api/chat/${encodeURIComponent(tabId)}/init`,
					{
						method: "POST",
						headers: token ? { Authorization: `Bearer ${token}` } : {},
					},
				)
				if (!res.ok) throw new Error(`init failed (${res.status})`)
				const body = (await res.json()) as { chatroomId: string }
				if (cancelled) return
				setChatroomId(body.chatroomId)
			} catch (err) {
				if (cancelled) return
				setInitError(err instanceof Error ? err.message : String(err))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [orgId, tabId])

	const { messages: messagesCollection, error: subscribeError } = useChatroom(chatroomId)

	const { data: messages = [] } = useLiveQuery(
		(q) => {
			if (!messagesCollection) return null as never
			return q
				.from({ m: messagesCollection })
				.orderBy(({ m }) => m.timestamp, "asc")
				.select(({ m }) => m)
		},
		[messagesCollection],
	)

	const messageCount = messages.length
	const lastMessage = messages[messageCount - 1]
	const isWaitingForAgent = isAwaitingReply && lastMessage?.role !== "agent"

	useEffect(() => {
		if (lastMessage?.role === "agent") setIsAwaitingReply(false)
	}, [lastMessage?.role, lastMessage?.key])

	const sendMessage = useCallback(
		async (text: string) => {
			if (!text.trim() || !orgId) return
			const token = await getTokenRef.current()
			const res = await fetch(
				`${chatAgentUrl}/api/chat/${encodeURIComponent(tabId)}/message`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(token ? { Authorization: `Bearer ${token}` } : {}),
					},
					body: JSON.stringify({ text }),
				},
			)
			if (!res.ok) {
				const body = await res.text().catch(() => "")
				throw new Error(`send failed (${res.status}): ${body || res.statusText}`)
			}
		},
		[orgId, tabId],
	)

	const [hasSettled, setHasSettled] = useState(false)
	useEffect(() => {
		setHasSettled(false)
	}, [tabId])
	useEffect(() => {
		if (messageCount > 0) {
			setHasSettled(true)
			return
		}
		const t = setTimeout(() => setHasSettled(true), 600)
		return () => clearTimeout(t)
	}, [messageCount, tabId])

	const handleSend = (text: string) => {
		const trimmed = text.trim()
		if (!trimmed || isWaitingForAgent) return
		if (messageCount === 0 && onFirstMessage) {
			onFirstMessage(tabId, trimmed.slice(0, 40))
		}
		setIsAwaitingReply(true)
		void sendMessage(trimmed).catch((err) => {
			console.error("[chat] sendMessage failed", err)
			setIsAwaitingReply(false)
		})
	}

	const connectionError = initError ?? subscribeError

	return (
		<div className="flex h-full flex-col">
			<Conversation className="flex-1 min-h-0">
				<ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
					{!hasSettled && messageCount === 0 ? (
						<ConversationLoadingSkeleton />
					) : messageCount === 0 ? (
						<ConversationEmptyState
							title="Maple AI"
							description="Ask me about your traces, logs, errors, and services."
						>
							<div className="mt-4 flex flex-col items-center gap-3">
								<div className="space-y-1 text-center">
									<h3 className="text-sm font-medium">Maple AI</h3>
									<p className="text-muted-foreground text-sm">
										Ask me about your traces, logs, errors, and services.
									</p>
								</div>
								<Suggestions className="mt-2 justify-center">
									{DEFAULT_SUGGESTIONS.map((s) => (
										<Suggestion key={s} suggestion={s} onClick={() => handleSend(s)} />
									))}
								</Suggestions>
							</div>
						</ConversationEmptyState>
					) : (
						<>
							{messages.map((m) => (
								<Message key={m.key} from={m.role === "user" ? "user" : "assistant"}>
									<MessageContent>
										<RichText>{m.text}</RichText>
									</MessageContent>
								</Message>
							))}
							{isWaitingForAgent && (
								<Message from="assistant">
									<MessageContent>
										<Shimmer>Thinking…</Shimmer>
									</MessageContent>
								</Message>
							)}
						</>
					)}
					{connectionError && (
						<div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
							Connection error: {connectionError}
						</div>
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>

			<div className="mx-auto w-full max-w-3xl px-4 pb-4">
				{messageCount > 0 && (
					<Suggestions className="mb-3">
						{DEFAULT_SUGGESTIONS.map((s) => (
							<Suggestion key={s} suggestion={s} onClick={() => handleSend(s)} />
						))}
					</Suggestions>
				)}
				<PromptInput
					onSubmit={({ text }) => handleSend(text)}
					className="rounded-lg border shadow-sm"
				>
					<PromptInputTextarea
						ref={textareaRef}
						placeholder="Ask about your system..."
						disabled={isWaitingForAgent}
					/>
					<PromptInputFooter>
						<PromptInputSubmit
							status={isWaitingForAgent ? "streaming" : "ready"}
							disabled={isWaitingForAgent}
						/>
					</PromptInputFooter>
				</PromptInput>
			</div>
		</div>
	)
}

export function ConversationLoadingSkeleton() {
	return (
		<div className="flex flex-col gap-3 py-6" aria-hidden>
			<div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
			<div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
			<div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
		</div>
	)
}
