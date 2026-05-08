import { useEffect, useMemo, useRef, useState } from "react"
import { useAgent } from "agents/react"
import { useAgentChat } from "@cloudflare/ai-chat/react"
import { useAuth } from "@clerk/clerk-react"
import { chatAgentUrl } from "@/lib/services/common/chat-agent-url"
import { useTypeAnywhereFocus } from "@/hooks/use-type-anywhere-focus"
import { alertPromptSuggestions, type AlertContext } from "./alert-context"
import { AlertAttachmentCard } from "./alert-attachment-card"
import {
	widgetFixAutoPrompt,
	widgetFixSuggestions,
	type WidgetFixContext,
} from "./widget-fix-context"
import { WidgetFixAttachmentCard } from "./widget-fix-attachment-card"
import {
	deriveAutoContexts,
	readChatReferrer,
	suggestionsForContexts,
	type AutoContext,
	type PageContextPayload,
} from "./auto-contexts"
import { PageContextChips } from "./page-context-chips"
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
import { ThinkingIndicator } from "@/components/ai-elements/thinking-indicator"
import { Tool } from "@/components/ai-elements/tool"
import { ApprovalCard } from "./approval-card"
import type { UIMessage } from "ai"

function shouldShowThinkingIndicator(
	message: UIMessage,
	isLoading: boolean,
	isLastMessage: boolean,
): boolean {
	if (!isLoading || !isLastMessage || message.role !== "assistant") return false
	const parts = message.parts
	if (parts.length === 0) return true
	const lastPart = parts[parts.length - 1]
	if (lastPart.type === "text" && (lastPart as { state?: string }).state === "streaming") return false
	return true
}

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
	mode?: "alert" | "widget-fix"
	alertContext?: AlertContext
	widgetFixContext?: WidgetFixContext
}

export function ChatConversation({
	tabId,
	isActive,
	onFirstMessage,
	mode,
	alertContext,
	widgetFixContext,
}: ChatConversationProps) {
	const { orgId, getToken } = useAuth()
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	useTypeAnywhereFocus(textareaRef, isActive)

	const referrerPath = useMemo(() => readChatReferrer(), [tabId])
	const derivedContexts = useMemo<AutoContext[]>(
		() => (referrerPath ? deriveAutoContexts(referrerPath) : []),
		[referrerPath],
	)
	const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
	useEffect(() => {
		setDismissed(new Set())
	}, [referrerPath])
	const activeContexts = useMemo(
		() => derivedContexts.filter((c) => !dismissed.has(c.id)),
		[derivedContexts, dismissed],
	)
	const dismissContext = (id: string) =>
		setDismissed((prev) => {
			const next = new Set(prev)
			next.add(id)
			return next
		})

	const agentName = orgId ? `${orgId}:${tabId}` : tabId
	const agent = useAgent({
		agent: "ChatAgent",
		name: agentName,
		host: chatAgentUrl,
		query: async () => ({ token: (await getToken()) ?? null }),
		queryDeps: [orgId],
		cacheTtl: 30_000,
	})

	const prepareSendMessagesRequest = useMemo(
		() => async (opts: { headers?: HeadersInit }) => {
			const token = await getToken()
			const headers = new Headers(opts.headers ?? {})
			if (token) headers.set("Authorization", `Bearer ${token}`)
			const out: Record<string, string> = {}
			headers.forEach((value, key) => {
				out[key] = value
			})
			return { headers: out }
		},
		[getToken],
	)

	const body = useMemo<Record<string, unknown>>(() => {
		const base: Record<string, unknown> = { orgId }
		if (mode === "alert" && alertContext) {
			base.mode = "alert"
			base.alertContext = alertContext
		}
		if (mode === "widget-fix" && widgetFixContext) {
			base.mode = "widget-fix"
			base.widgetFixContext = widgetFixContext
		}
		if (mode !== "widget-fix" && activeContexts.length > 0 && referrerPath) {
			const payload: PageContextPayload = {
				pathname: referrerPath,
				contexts: activeContexts,
			}
			base.pageContext = payload
		}
		return base
	}, [orgId, mode, alertContext, widgetFixContext, activeContexts, referrerPath])

	const { messages, sendMessage, status, addToolApprovalResponse } = useAgentChat({
		agent,
		body,
		getInitialMessages: null,
		prepareSendMessagesRequest,
	})

	const [hasSettled, setHasSettled] = useState(false)
	useEffect(() => {
		setHasSettled(false)
	}, [agentName])
	useEffect(() => {
		if (messages.length > 0) {
			setHasSettled(true)
			return
		}
		const t = setTimeout(() => setHasSettled(true), 600)
		return () => clearTimeout(t)
	}, [messages.length, agentName])

	const isLoading = status === "streaming" || status === "submitted"
	const isAlertMode = mode === "alert" && !!alertContext
	const isWidgetFixMode = mode === "widget-fix" && !!widgetFixContext
	const suggestions = useMemo(() => {
		if (isAlertMode) return alertPromptSuggestions(alertContext!)
		if (isWidgetFixMode) return widgetFixSuggestions(widgetFixContext!)
		const routeAware = suggestionsForContexts(activeContexts)
		return routeAware ?? DEFAULT_SUGGESTIONS
	}, [isAlertMode, alertContext, isWidgetFixMode, widgetFixContext, activeContexts])

	const handleSend = (text: string) => {
		if (!text.trim() || isLoading) return
		if (messages.length === 0 && onFirstMessage) {
			onFirstMessage(tabId, text.trim().slice(0, 40))
		}
		sendMessage({ text: text.trim() })
	}

	const widgetFixAutoSentRef = useRef<string | null>(null)
	useEffect(() => {
		if (!isWidgetFixMode || !isActive) return
		if (!hasSettled || isLoading) return
		if (messages.length > 0) return
		if (widgetFixAutoSentRef.current === tabId) return
		widgetFixAutoSentRef.current = tabId
		handleSend(widgetFixAutoPrompt)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isWidgetFixMode, isActive, hasSettled, isLoading, messages.length, tabId])

	return (
		<div className="flex h-full flex-col">
			{isAlertMode && <AlertAttachmentCard alert={alertContext!} />}
			{isWidgetFixMode && <WidgetFixAttachmentCard ctx={widgetFixContext!} />}
			<Conversation className="flex-1 min-h-0">
				<ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
					{!hasSettled && messages.length === 0 ? (
						<ConversationLoadingSkeleton />
					) : messages.length === 0 ? (
						isAlertMode ? (
							<div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
								<p className="text-xs uppercase tracking-[0.14em] text-muted-foreground/70">
									Ready to investigate
								</p>
								<p className="max-w-sm text-sm text-muted-foreground">
									The alert above is attached to every message in this thread. Start with a
									suggestion or ask your own question.
								</p>
							</div>
						) : isWidgetFixMode ? (
							<div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
								<p className="text-xs uppercase tracking-[0.14em] text-muted-foreground/70">
									Diagnosing widget…
								</p>
								<p className="max-w-sm text-sm text-muted-foreground">
									Maple AI is reading the broken widget config and the validation error.
									It will propose a corrected widget JSON for you to approve.
								</p>
							</div>
						) : (
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
										{suggestions.map((s) => (
											<Suggestion
												key={s}
												suggestion={s}
												onClick={() => handleSend(s)}
											/>
										))}
									</Suggestions>
								</div>
							</ConversationEmptyState>
						)
					) : (
						<>
							{messages.map((message, messageIndex) => {
								const isLastMessage = messageIndex === messages.length - 1
								return (
									<Message key={message.id} from={message.role}>
										<MessageContent>
											{message.parts.map((part, i) => {
												if (part.type === "text") {
													return <RichText key={i}>{part.text}</RichText>
												}
												if (
													part.type.startsWith("tool-") ||
													part.type === "dynamic-tool"
												) {
													const toolPart = part as {
														type: string
														toolCallId: string
														toolName?: string
														state: string
														input?: unknown
														output?: unknown
														errorText?: string
														approval?: { id: string }
													}
													const toolName = part.type.startsWith("tool-")
														? part.type.replace(/^tool-/, "")
														: (toolPart.toolName ?? "unknown")
													if (
														toolPart.state === "approval-requested" &&
														toolPart.approval?.id
													) {
														return (
															<ApprovalCard
																key={toolPart.toolCallId ?? i}
																toolName={toolName}
																input={toolPart.input}
																approvalId={toolPart.approval.id}
																onApprove={(id) =>
																	addToolApprovalResponse({
																		id,
																		approved: true,
																	})
																}
																onDeny={(id) =>
																	addToolApprovalResponse({
																		id,
																		approved: false,
																	})
																}
															/>
														)
													}
													return (
														<Tool
															key={toolPart.toolCallId ?? i}
															toolName={toolName}
															toolCallId={toolPart.toolCallId}
															state={toolPart.state}
															input={toolPart.input}
															output={toolPart.output}
															errorText={toolPart.errorText}
														/>
													)
												}
												return null
											})}
											{shouldShowThinkingIndicator(
												message,
												isLoading,
												isLastMessage,
											) && <ThinkingIndicator />}
										</MessageContent>
									</Message>
								)
							})}
							{isLoading && messages[messages.length - 1]?.role === "user" && (
								<Message from="assistant">
									<MessageContent>
										<Shimmer>Thinking...</Shimmer>
									</MessageContent>
								</Message>
							)}
						</>
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>

			<div className="mx-auto w-full max-w-3xl px-4 pb-4">
				{(messages.length > 0 || isAlertMode || isWidgetFixMode) && (
					<Suggestions className="mb-3">
						{suggestions.map((s) => (
							<Suggestion key={s} suggestion={s} onClick={() => handleSend(s)} />
						))}
					</Suggestions>
				)}
				{!isWidgetFixMode && (
					<PageContextChips contexts={activeContexts} onDismiss={dismissContext} />
				)}
				<PromptInput
					onSubmit={({ text }) => handleSend(text)}
					className="rounded-lg border shadow-sm"
				>
					<PromptInputTextarea
						ref={textareaRef}
						placeholder={
							isAlertMode
								? "Ask about this alert..."
								: isWidgetFixMode
									? "Ask about this widget..."
									: "Ask about your system..."
						}
						disabled={isLoading}
					/>
					<PromptInputFooter>
						<PromptInputSubmit status={status} disabled={isLoading && status !== "streaming"} />
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
