import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Exit } from "effect"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { toast } from "sonner"
import { useAtomSet } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useFlueChat } from "@/hooks/use-flue-chat"
import { useTypeAnywhereFocus } from "@/hooks/use-type-anywhere-focus"
import {
	investigationNoun,
	investigationSuggestions,
	type InvestigationContext,
} from "./investigation-context"
import { InvestigationAttachmentCard } from "./investigation-attachment-card"
import { widgetFixAutoPrompt, widgetFixSuggestions, type WidgetFixContext } from "./widget-fix-context"
import { WidgetFixAttachmentCard } from "./widget-fix-attachment-card"
import {
	deriveAutoContexts,
	readChatReferrer,
	suggestionsForContexts,
	type AutoContext,
	type PageContextPayload,
} from "./auto-contexts"
import type { ChatContext } from "./context-preamble"
import { parseToolProposal } from "./tool-proposal"
import { parseDiagnosisMarker } from "./diagnosis-marker"
import { DiagnosisReportCard } from "./diagnosis-report-card"
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
import { Tool, ToolRow, toolLabel } from "@/components/ai-elements/tool"
import { ToolGroup } from "@/components/ai-elements/tool-group"
import { ApprovalCard } from "./approval-card"
import { makeChatApplyPayload } from "./chat-apply-payload"
import type { UIMessage } from "@/components/ai-elements/types"

type ToolPart = {
	type: string
	toolCallId: string
	toolName?: string
	state: string
	input?: unknown
	output?: unknown
	errorText?: string
}

function isToolPart(part: UIMessage["parts"][number]): boolean {
	return part.type.startsWith("tool-") || part.type === "dynamic-tool"
}

function toolNameFor(part: ToolPart): string {
	if (part.type.startsWith("tool-")) return part.type.replace(/^tool-/, "")
	return part.toolName ?? "unknown"
}

function deriveToolStatus(state: string): "running" | "completed" | "error" {
	if (state === "output-available") return "completed"
	if (state === "output-error" || state === "output-denied") return "error"
	return "running"
}

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
	onLoadingChange?: (tabId: string, loading: boolean) => void
	mode?: "widget-fix" | "investigation"
	investigationContext?: InvestigationContext
	widgetFixContext?: WidgetFixContext
	/** Read-only shared view: render the conversation with no composer. */
	readOnly?: boolean
}

export function ChatConversation({
	tabId,
	isActive,
	onFirstMessage,
	onLoadingChange,
	mode,
	investigationContext,
	widgetFixContext,
	readOnly = false,
}: ChatConversationProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	useTypeAnywhereFocus(textareaRef, isActive && !readOnly)

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

	// Per-conversation context, folded into the first message preamble by the
	// adapter (Flue's `agents.send` carries only a message string).
	const context = useMemo<ChatContext>(() => {
		const base: ChatContext = {}
		if (mode === "investigation" && investigationContext) {
			base.mode = "investigation"
			base.investigationContext = investigationContext
		}
		if (mode === "widget-fix" && widgetFixContext) {
			base.mode = "widget-fix"
			base.widgetFixContext = widgetFixContext
		}
		// An explicit subject (investigation/widget-fix) supersedes implicit page context.
		if (mode !== "widget-fix" && mode !== "investigation" && activeContexts.length > 0 && referrerPath) {
			const payload: PageContextPayload = {
				pathname: referrerPath,
				contexts: activeContexts,
			}
			base.pageContext = payload
		}
		return base
	}, [mode, investigationContext, widgetFixContext, activeContexts, referrerPath])

	const { messages, status, isLoading, sendMessage } = useFlueChat({ tabId, context })

	// Apply an approved proposal via Maple's authenticated API (propose-then-apply).
	const applyProposal = useAtomSet(MapleApiAtomClient.mutation("chat", "apply"), {
		mode: "promiseExit",
	})
	const [resolvedApprovals, setResolvedApprovals] = useState<Map<string, "applied" | "denied">>(
		() => new Map(),
	)
	const resolveApproval = (toolCallId: string, outcome: "applied" | "denied") =>
		setResolvedApprovals((prev) => {
			const next = new Map(prev)
			next.set(toolCallId, outcome)
			return next
		})
	const handleApprove = async (toolCallId: string, tool: string, input: unknown) => {
		const exit = await applyProposal({ payload: makeChatApplyPayload(tool, input) })
		if (Exit.isSuccess(exit)) {
			if (exit.value.isError) {
				toast.error(exit.value.content || `Couldn't apply ${tool}`)
				return
			}
			resolveApproval(toolCallId, "applied")
			toast.success("Change applied")
		} else {
			toast.error(`Failed to apply ${tool}`)
		}
	}

	const [hasSettled, setHasSettled] = useState(false)
	useEffect(() => {
		setHasSettled(false)
	}, [tabId])
	useEffect(() => {
		if (messages.length > 0) {
			setHasSettled(true)
			return
		}
		const t = setTimeout(() => setHasSettled(true), 600)
		return () => clearTimeout(t)
	}, [messages.length, tabId])

	useEffect(() => {
		onLoadingChange?.(tabId, isLoading)
	}, [tabId, isLoading, onLoadingChange])
	useEffect(() => {
		return () => onLoadingChange?.(tabId, false)
	}, [tabId, onLoadingChange])
	const isInvestigationMode = mode === "investigation" && !!investigationContext
	const isWidgetFixMode = mode === "widget-fix" && !!widgetFixContext
	const suggestions = useMemo(() => {
		if (isInvestigationMode) return investigationSuggestions(investigationContext!)
		if (isWidgetFixMode) return widgetFixSuggestions(widgetFixContext!)
		const routeAware = suggestionsForContexts(activeContexts)
		return routeAware ?? DEFAULT_SUGGESTIONS
	}, [isInvestigationMode, investigationContext, isWidgetFixMode, widgetFixContext, activeContexts])

	const handleSend = (text: string) => {
		if (!text.trim() || isLoading) return
		if (messages.length === 0 && onFirstMessage) {
			onFirstMessage(tabId, text.trim().slice(0, 40))
		}
		sendMessage(text.trim())
	}

	// Auto-send the fix prompt once a fresh widget-fix conversation is ready.
	// Mounting the zero-DOM trigger IS the one-shot (see `WidgetFixAutoSendTrigger`):
	// the gate below decides when to fire, replacing the prior ref-latch +
	// `eslint-disable` effect. Sending bumps `messages.length`, which unmounts it.
	const shouldAutoSendWidgetFix =
		!readOnly && isWidgetFixMode && isActive && hasSettled && !isLoading && messages.length === 0

	return (
		<div className="flex h-full flex-col">
			{shouldAutoSendWidgetFix ? (
				<WidgetFixAutoSendTrigger onFire={() => handleSend(widgetFixAutoPrompt)} />
			) : null}
			{isInvestigationMode && <InvestigationAttachmentCard ctx={investigationContext!} />}
			{isWidgetFixMode && <WidgetFixAttachmentCard ctx={widgetFixContext!} />}
			<Conversation className="flex-1 min-h-0">
				<ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
					{!hasSettled && messages.length === 0 ? (
						<ConversationLoadingSkeleton />
					) : messages.length === 0 ? (
						readOnly ? (
							<div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
								<p className="text-xs uppercase tracking-[0.14em] text-muted-foreground/70">
									Shared conversation
								</p>
								<p className="max-w-sm text-sm text-muted-foreground">
									This shared conversation is unavailable or empty. It may have been
									deleted, or belong to a different workspace than the one you're signed in
									to.
								</p>
							</div>
						) : isInvestigationMode ? (
							<div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
								<p className="text-xs uppercase tracking-[0.14em] text-muted-foreground/70">
									Ready to investigate
								</p>
								<p className="max-w-sm text-sm text-muted-foreground">
									The {investigationNoun(investigationContext!.kind)} above is attached to
									every message in this thread. Start with a suggestion or ask your own
									question.
								</p>
							</div>
						) : isWidgetFixMode ? (
							<div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
								<p className="text-xs uppercase tracking-[0.14em] text-muted-foreground/70">
									Diagnosing widget…
								</p>
								<p className="max-w-sm text-sm text-muted-foreground">
									Maple AI is reading the broken widget config and the validation error. It
									will propose a corrected widget JSON for you to approve.
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
											{(() => {
												const nodes: ReactNode[] = []
												let toolBuf: ToolPart[] = []
												const flushTools = () => {
													if (toolBuf.length === 0) return
													const buf = toolBuf
													toolBuf = []
													if (buf.length === 1) {
														const t = buf[0]!
														nodes.push(
															<Tool
																key={t.toolCallId ?? `tool-${nodes.length}`}
																toolName={toolNameFor(t)}
																toolCallId={t.toolCallId}
																state={t.state}
																input={t.input}
																output={t.output}
																errorText={t.errorText}
															/>,
														)
														return
													}
													const runningCount = buf.filter(
														(t) => deriveToolStatus(t.state) === "running",
													).length
													const errorCount = buf.filter(
														(t) => deriveToolStatus(t.state) === "error",
													).length
													const lastRunning = [...buf]
														.reverse()
														.find((t) => deriveToolStatus(t.state) === "running")
													nodes.push(
														<ToolGroup
															key={`group-${buf[0]!.toolCallId ?? nodes.length}`}
															count={buf.length}
															runningCount={runningCount}
															errorCount={errorCount}
															completedCount={buf.length - runningCount}
															currentLabel={
																lastRunning
																	? toolLabel(toolNameFor(lastRunning))
																	: undefined
															}
														>
															{buf.map((t) => (
																<ToolRow
																	key={t.toolCallId}
																	toolName={toolNameFor(t)}
																	toolCallId={t.toolCallId}
																	state={t.state}
																	input={t.input}
																	output={t.output}
																	errorText={t.errorText}
																/>
															))}
														</ToolGroup>,
													)
												}
												for (let i = 0; i < message.parts.length; i++) {
													const part = message.parts[i]!
													if (part.type === "text") {
														flushTools()
														nodes.push(
															<RichText key={`text-${i}`}>
																{part.text}
															</RichText>,
														)
														continue
													}
													if (isToolPart(part)) {
														const tp = part as ToolPart
														const diagnosis =
															tp.state === "output-available"
																? parseDiagnosisMarker(tp.output)
																: null
														if (diagnosis) {
															flushTools()
															nodes.push(
																<DiagnosisReportCard
																	key={tp.toolCallId ?? `diagnosis-${i}`}
																	report={diagnosis.report}
																/>,
															)
															continue
														}
														const proposal =
															tp.state === "output-available"
																? parseToolProposal(tp.output)
																: null
														if (proposal) {
															flushTools()
															const resolved = resolvedApprovals.get(
																tp.toolCallId,
															)
															nodes.push(
																<ApprovalCard
																	key={tp.toolCallId ?? `approval-${i}`}
																	toolName={proposal.tool}
																	input={proposal.input}
																	resolved={resolved}
																	onApprove={() =>
																		handleApprove(
																			tp.toolCallId,
																			proposal.tool,
																			proposal.input,
																		)
																	}
																	onDeny={() =>
																		resolveApproval(
																			tp.toolCallId,
																			"denied",
																		)
																	}
																/>,
															)
															continue
														}
														toolBuf.push(tp)
														continue
													}
												}
												flushTools()
												return nodes
											})()}
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

			{!readOnly && (
				<div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
					{messages.length === 0 && (isInvestigationMode || isWidgetFixMode) && (
						<Suggestions className="mb-3">
							{suggestions.map((s) => (
								<Suggestion key={s} suggestion={s} onClick={() => handleSend(s)} />
							))}
						</Suggestions>
					)}
					{!isWidgetFixMode && !isInvestigationMode && (
						<PageContextChips contexts={activeContexts} onDismiss={dismissContext} />
					)}
					<PromptInput
						onSubmit={({ text }) => handleSend(text)}
						className="rounded-lg border shadow-sm"
					>
						<PromptInputTextarea
							ref={textareaRef}
							placeholder={
								isInvestigationMode
									? `Ask about this ${investigationNoun(investigationContext!.kind)}...`
									: isWidgetFixMode
										? "Ask about this widget..."
										: "Ask about your system..."
							}
							disabled={isLoading}
						/>
						<PromptInputFooter>
							<PromptInputSubmit
								status={status}
								disabled={isLoading && status !== "streaming"}
							/>
						</PromptInputFooter>
					</PromptInput>
				</div>
			)}
		</div>
	)
}

/**
 * Zero-DOM trigger: firing once on mount is how a ready, empty widget-fix
 * conversation auto-sends its fix prompt. The parent only renders this when the
 * conditions hold, so mounting is the one-shot (mirrors `AutoRunTrigger`).
 */
function WidgetFixAutoSendTrigger({ onFire }: { onFire: () => void }) {
	useMountEffect(() => {
		onFire()
	})
	return null
}

function ConversationLoadingSkeleton() {
	return (
		<div className="flex flex-col gap-3 py-6" aria-hidden>
			<div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
			<div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
			<div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
		</div>
	)
}
