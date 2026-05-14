import { useCallback, useEffect, useRef, useState } from "react"
import { useAuth } from "@clerk/clerk-react"
import { useChat } from "@electric-ax/agents-runtime/react"
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

	const [entityUrl, setEntityUrl] = useState<string | null>(null)
	const [initError, setInitError] = useState<string | null>(null)
	const [isSending, setIsSending] = useState(false)
	// Bumped to force useChatroom to re-`observe(entity(...))` — the only
	// reliable way to flush new SSE events into TanStack collections in
	// this version of `@durable-streams/state` (see upstream-bug-#3).
	const [refreshTick, setRefreshTick] = useState(0)

	const getTokenRef = useRef(getToken)
	useEffect(() => {
		getTokenRef.current = getToken
	}, [getToken])

	// 1. Spawn entity (idempotent) and learn its entityUrl. The entity's
	//    durable stream is what useChat materializes into a timeline.
	useEffect(() => {
		if (!orgId) {
			setEntityUrl(null)
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
				const body = (await res.json()) as { entityUrl: string }
				if (cancelled) return
				setEntityUrl(body.entityUrl)
			} catch (err) {
				if (cancelled) return
				setInitError(err instanceof Error ? err.message : String(err))
			}
		})()
		return () => {
			cancelled = true
		}
	}, [orgId, tabId])

	// 2. Observe the entity stream as a TanStack DB EntityStreamDB and feed
	//    it to `useChat(db)`. The hook returns `sections` that already merge
	//    user messages + streaming agent responses (text_delta accumulates
	//    in `items[].text` in real time) + tool calls.
	const { db, error: subscribeError } = useChatroom(entityUrl, refreshTick)
	const { sections, state } = useChat(db)

	const renderableSections = sections.filter((s) => {
		if (s.kind === "user_message") {
			// Skip the "ready" placeholder (it has isInitial set when wired
			// through initialMessage, but we no longer send one — keep guard
			// anyway in case an older entity is loaded).
			return !(s.isInitial && (s.text === "ready" || s.text === ""))
		}
		if (s.kind === "wake") return false
		return true
	})
	const sectionCount = renderableSections.length
	const lastSection = renderableSections[sectionCount - 1]
	// A brand-new entity reports `state === "pending"` until the user sends
	// the first message — we shouldn't disable the input in that case.
	const agentRunInProgress =
		state === "working" ||
		state === "queued" ||
		(lastSection?.kind === "agent_response" && !lastSection.done)
	const isLoading = isSending || agentRunInProgress

	useEffect(() => {
		if (lastSection?.kind === "agent_response" && lastSection.done) {
			setIsSending(false)
		}
	}, [lastSection])

	// While we're waiting for a reply (either we just sent and the SSE
	// stream hasn't surfaced anything yet, or the agent is mid-stream),
	// re-`observe` the entity every 800ms so the new text_delta events
	// land in fresh collections that `useChat` can pick up. Stops as soon
	// as the latest section is a completed `agent_response`.
	useEffect(() => {
		if (!isLoading) return
		const id = setInterval(() => setRefreshTick((t) => t + 1), 800)
		return () => clearInterval(id)
	}, [isLoading])

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
		if (sectionCount > 0) {
			setHasSettled(true)
			return
		}
		const t = setTimeout(() => setHasSettled(true), 600)
		return () => clearTimeout(t)
	}, [sectionCount, tabId])

	const handleSend = (text: string) => {
		const trimmed = text.trim()
		if (!trimmed || isLoading) return
		if (sectionCount === 0 && onFirstMessage) {
			onFirstMessage(tabId, trimmed.slice(0, 40))
		}
		setIsSending(true)
		void sendMessage(trimmed).catch((err) => {
			console.error("[chat] sendMessage failed", err)
			setIsSending(false)
		})
	}

	const connectionError = initError ?? subscribeError

	return (
		<div className="flex h-full flex-col">
			<Conversation className="flex-1 min-h-0">
				<ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
					{!hasSettled && sectionCount === 0 ? (
						<ConversationLoadingSkeleton />
					) : sectionCount === 0 ? (
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
							{renderableSections.map((section, idx) => {
								if (section.kind === "user_message") {
									return (
										<Message key={`u:${idx}:${section.timestamp}`} from="user">
											<MessageContent>
												<RichText>{section.text}</RichText>
											</MessageContent>
										</Message>
									)
								}
								if (section.kind !== "agent_response") return null
								const text = section.items
									.filter(
										(it): it is { kind: "text"; text: string } =>
											it.kind === "text",
									)
									.map((it) => it.text)
									.join("")
								return (
									<Message key={`a:${idx}`} from="assistant">
										<MessageContent>
											<RichText>{text}</RichText>
										</MessageContent>
									</Message>
								)
							})}
							{isSending && lastSection?.kind === "user_message" && (
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
				{sectionCount > 0 && (
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
						disabled={isLoading}
					/>
					<PromptInputFooter>
						<PromptInputSubmit
							status={isLoading ? "streaming" : "ready"}
							disabled={isLoading}
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
