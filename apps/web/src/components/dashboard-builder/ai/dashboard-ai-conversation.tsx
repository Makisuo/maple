import { useEffect, useMemo, useState } from "react"
import { useAgent } from "agents/react"
import { useAgentChat } from "@cloudflare/ai-chat/react"
import { useAuth } from "@clerk/clerk-react"
import { chatAgentUrl } from "@/lib/services/common/chat-agent-url"
import { ConversationLoadingSkeleton } from "@/components/chat/chat-conversation"
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
import { WidgetProposalCard } from "./widget-proposal-card"
import { WidgetRemovalCard } from "./widget-removal-card"
import { normalizeAiWidgetProposal } from "./normalize-widget-proposal"
import { useDashboardActions } from "@/components/dashboard-builder/dashboard-actions-context"
import type { UIMessage } from "ai"
import type {
	DashboardWidget,
	VisualizationType,
	WidgetDataSource,
	WidgetDisplayConfig,
} from "@/components/dashboard-builder/types"

const DASHBOARD_SUGGESTIONS = [
	"Add an error rate stat widget",
	"Show me a service overview table",
	"Create a latency chart by service",
	"Build a dashboard to monitor my services",
]

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

interface DashboardAiConversationProps {
	dashboardName: string
	widgets: DashboardWidget[]
}

export function DashboardAiConversation({ dashboardName, widgets }: DashboardAiConversationProps) {
	const { dashboardId, addWidget, removeWidget } = useDashboardActions()
	const { orgId, getToken } = useAuth()

	const agentName = orgId ? `${orgId}:dashboard-${dashboardId}` : `dashboard-${dashboardId}`
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

	const { messages, sendMessage, status, error } = useAgentChat({
		agent,
		body: {
			orgId,
			mode: "dashboard_builder",
			dashboardContext: {
				dashboardName,
				existingWidgets: widgets.map((w) => ({
					title: w.display.title ?? "Untitled",
					visualization: w.visualization,
				})),
			},
		},
		getInitialMessages: null,
		prepareSendMessagesRequest,
	})

	const isLoading = status === "streaming" || status === "submitted"

	const [hasSettled, setHasSettled] = useState(false)
	useEffect(() => {
		if (messages.length > 0) {
			setHasSettled(true)
			return
		}
		const t = setTimeout(() => setHasSettled(true), 600)
		return () => clearTimeout(t)
	}, [messages.length, dashboardId])
	useEffect(() => {
		setHasSettled(false)
	}, [dashboardId])

	const handleSend = (text: string) => {
		if (!text.trim() || isLoading) return
		sendMessage({ text: text.trim() })
	}

	if (error) {
		console.error("[dashboard-ai]", error)
	}

	return (
		<div className="flex h-full flex-col">
			{error && (
				<div className="mx-4 mt-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
					{error.message || "Connection error"}
				</div>
			)}
			<Conversation className="flex-1 min-h-0">
				<ConversationContent className="mx-auto w-full gap-4 p-4">
					{!hasSettled && messages.length === 0 ? (
						<ConversationLoadingSkeleton />
					) : messages.length === 0 ? (
						<ConversationEmptyState
							title="Dashboard AI"
							description="Tell me what you want to visualize and I'll add widgets to your dashboard."
						>
							<div className="mt-3 flex flex-col items-center gap-2">
								<Suggestions className="mt-1 flex-wrap justify-center">
									{DASHBOARD_SUGGESTIONS.map((s) => (
										<Suggestion key={s} suggestion={s} onClick={() => handleSend(s)} />
									))}
								</Suggestions>
							</div>
						</ConversationEmptyState>
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
													}
													const toolName = part.type.startsWith("tool-")
														? part.type.replace(/^tool-/, "")
														: (toolPart.toolName ?? "unknown")

													if (toolName === "add_dashboard_widget") {
														const input = toolPart.input as
															| {
																	visualization?: VisualizationType
																	dataSource?: WidgetDataSource
																	display?: WidgetDisplayConfig
															  }
															| undefined
														if (
															!input?.visualization ||
															!input.dataSource ||
															!input.display
														) {
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
														const normalized = normalizeAiWidgetProposal({
															visualization: input.visualization,
															dataSource: input.dataSource,
															display: input.display,
														})

														if (normalized.kind === "blocked") {
															return (
																<WidgetProposalCard
																	key={toolPart.toolCallId ?? i}
																	input={normalized.proposal}
																	disabledReason={normalized.reason}
																/>
															)
														}

														return (
															<WidgetProposalCard
																key={toolPart.toolCallId ?? i}
																input={normalized.proposal}
																onAccept={() => {
																	addWidget(
																		normalized.proposal.visualization,
																		normalized.proposal.dataSource,
																		normalized.proposal.display,
																	)
																}}
															/>
														)
													}

													if (toolName === "remove_dashboard_widget") {
														const input = toolPart.input as
															| {
																	widgetTitle?: string
															  }
															| undefined
														if (!input?.widgetTitle) {
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
														return (
															<WidgetRemovalCard
																key={toolPart.toolCallId ?? i}
																input={{ widgetTitle: input.widgetTitle }}
																widgets={widgets}
																onConfirm={removeWidget}
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
										<Shimmer>Thinking…</Shimmer>
									</MessageContent>
								</Message>
							)}
						</>
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>

			<div className="w-full px-4 pb-4">
				<PromptInput
					onSubmit={({ text }) => handleSend(text)}
					className="rounded-lg border shadow-sm"
				>
					<PromptInputTextarea
						placeholder="Describe what you want to visualize..."
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
