import { useEffect, useMemo, useRef, useState } from "react"
import { useChat } from "@electric-ax/agents-runtime/react"
import { useAuth } from "@clerk/clerk-react"
import { requiresApproval } from "@maple/ai"
import { useTypeAnywhereFocus } from "@/hooks/use-type-anywhere-focus"
import { alertPromptSuggestions, type AlertContext } from "./alert-context"
import { AlertAttachmentCard } from "./alert-attachment-card"
import { widgetFixAutoPrompt, widgetFixSuggestions, type WidgetFixContext } from "./widget-fix-context"
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
import {
	ensureMapleChatSession,
	observeMapleChatSession,
	sendMapleApprovalResponse,
	sendMapleChatMessage,
	type EntityStreamDB,
	type EntityTimelineSection,
	type MapleChatSession,
} from "@/lib/services/ai/electric-chat"

type PromptStatus = "submitted" | "streaming" | "ready" | "error"

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

const isApprovalResponseText = (text: string): boolean => {
	try {
		const parsed = JSON.parse(text) as { approvalId?: unknown; approved?: unknown }
		return typeof parsed.approvalId === "string" && typeof parsed.approved === "boolean"
	} catch {
		return false
	}
}

const mapToolStatus = (status: string): string => {
	switch (status) {
		case "completed":
			return "output-available"
		case "failed":
			return "output-error"
		default:
			return "input-available"
	}
}

const parseApprovalResult = (result: string | undefined): { approvalId?: string; status?: string } | null => {
	if (!result) return null
	try {
		const parsed = JSON.parse(result) as {
			details?: { status?: unknown; approvalId?: unknown }
		}
		if (parsed.details?.status === "approval_required") {
			return {
				status: parsed.details.status,
				approvalId:
					typeof parsed.details.approvalId === "string" ? parsed.details.approvalId : undefined,
			}
		}
		return null
	} catch {
		return null
	}
}

export function ChatConversation({
	tabId,
	isActive,
	onFirstMessage,
	mode,
	alertContext,
	widgetFixContext,
}: ChatConversationProps) {
	const { orgId } = useAuth()
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

	const [session, setSession] = useState<MapleChatSession | null>(null)
	const [db, setDb] = useState<EntityStreamDB | null>(null)
	const [sessionError, setSessionError] = useState<string | null>(null)
	const [sendError, setSendError] = useState<string | null>(null)
	const [pendingSend, setPendingSend] = useState(false)
	const [answeredApprovals, setAnsweredApprovals] = useState<Set<string>>(() => new Set())

	const body = useMemo<Record<string, unknown>>(() => {
		const base: Record<string, unknown> = {}
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
	}, [mode, alertContext, widgetFixContext, activeContexts, referrerPath])

	useEffect(() => {
		let cancelled = false
		let close: (() => void) | null = null
		setSession(null)
		setDb(null)
		setSessionError(null)
		setSendError(null)
		setAnsweredApprovals(new Set())

		ensureMapleChatSession({ tabId })
			.then(async (nextSession) => {
				const observation = await observeMapleChatSession(nextSession)
				if (cancelled) {
					observation.close()
					return
				}
				close = observation.close
				setSession(nextSession)
				setDb(observation.db)
			})
			.catch((error) => {
				if (cancelled) return
				setSessionError(error instanceof Error ? error.message : String(error))
			})

		return () => {
			cancelled = true
			close?.()
		}
	}, [tabId, orgId])

	const { sections, state: timelineState } = useChat(db)
	const visibleSections = useMemo(
		() =>
			sections.filter(
				(section) => section.kind !== "user_message" || !isApprovalResponseText(section.text),
			),
		[sections],
	)
	const visibleUserMessageCount = useMemo(
		() => visibleSections.filter((section) => section.kind === "user_message").length,
		[visibleSections],
	)
	const hasVisibleMessages = visibleSections.length > 0

	const [hasSettled, setHasSettled] = useState(false)
	useEffect(() => {
		setHasSettled(false)
	}, [tabId, orgId])
	useEffect(() => {
		if (hasVisibleMessages || sessionError) {
			setHasSettled(true)
			return
		}
		const t = setTimeout(() => setHasSettled(true), 600)
		return () => clearTimeout(t)
	}, [hasVisibleMessages, sessionError, tabId, orgId])

	const isInitializing = session == null && sessionError == null
	const isLoading =
		pendingSend ||
		isInitializing ||
		timelineState === "pending" ||
		timelineState === "queued" ||
		timelineState === "working"
	const status: PromptStatus = sessionError
		? "error"
		: timelineState === "working"
			? "streaming"
			: isLoading
				? "submitted"
				: "ready"
	const isAlertMode = mode === "alert" && !!alertContext
	const isWidgetFixMode = mode === "widget-fix" && !!widgetFixContext
	const suggestions = useMemo(() => {
		if (isAlertMode) return alertPromptSuggestions(alertContext!)
		if (isWidgetFixMode) return widgetFixSuggestions(widgetFixContext!)
		const routeAware = suggestionsForContexts(activeContexts)
		return routeAware ?? DEFAULT_SUGGESTIONS
	}, [isAlertMode, alertContext, isWidgetFixMode, widgetFixContext, activeContexts])

	const handleSend = async (text: string) => {
		if (!text.trim() || isLoading) return
		if (!session) return
		const trimmed = text.trim()
		if (visibleUserMessageCount === 0 && onFirstMessage) {
			onFirstMessage(tabId, trimmed.slice(0, 40))
		}
		setPendingSend(true)
		setSendError(null)
		try {
			await sendMapleChatMessage(session.id, { ...body, text: trimmed })
		} catch (error) {
			setSendError(error instanceof Error ? error.message : String(error))
		} finally {
			setPendingSend(false)
		}
	}

	const handleApprovalResponse = async (approvalId: string, approved: boolean) => {
		if (!session) return
		try {
			await sendMapleApprovalResponse(session.id, approvalId, approved)
			setAnsweredApprovals((prev) => {
				const next = new Set(prev)
				next.add(approvalId)
				return next
			})
		} catch (error) {
			setSendError(error instanceof Error ? error.message : String(error))
		}
	}

	// handleSend is a fresh closure each render; we intentionally pin the
	// auto-send to (tabId, mode-readiness) via a ref so we never replay it.
	const handleSendRef = useRef(handleSend)
	handleSendRef.current = handleSend
	const widgetFixAutoSentRef = useRef<string | null>(null)
	useEffect(() => {
		if (!isWidgetFixMode || !isActive) return
		if (!session || !hasSettled || isLoading) return
		if (visibleUserMessageCount > 0) return
		if (widgetFixAutoSentRef.current === tabId) return
		widgetFixAutoSentRef.current = tabId
		void handleSendRef.current(widgetFixAutoPrompt)
	}, [isWidgetFixMode, isActive, hasSettled, isLoading, visibleUserMessageCount, tabId, session])

	return (
		<div className="flex h-full flex-col">
			{isAlertMode && <AlertAttachmentCard alert={alertContext!} />}
			{isWidgetFixMode && <WidgetFixAttachmentCard ctx={widgetFixContext!} />}
			<Conversation className="flex-1 min-h-0">
				<ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
					{!hasSettled && !hasVisibleMessages ? (
						<ConversationLoadingSkeleton />
					) : sessionError ? (
						<div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
							<p className="text-xs uppercase tracking-[0.14em] text-destructive/80">
								Chat unavailable
							</p>
							<p className="max-w-sm text-sm text-muted-foreground">{sessionError}</p>
						</div>
					) : !hasVisibleMessages ? (
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
							{visibleSections.map((section, sectionIndex) => (
								<ChatTimelineSection
									key={sectionIndex}
									section={section}
									isLoading={isLoading}
									isLastSection={sectionIndex === visibleSections.length - 1}
									answeredApprovals={answeredApprovals}
									onApprovalResponse={handleApprovalResponse}
								/>
							))}
							{isLoading &&
								visibleSections[visibleSections.length - 1]?.kind === "user_message" && (
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

			<div className="mx-auto w-full max-w-3xl px-4 pb-4">
				{sendError && (
					<div
						role="alert"
						className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
					>
						{sendError}
					</div>
				)}
				{(hasVisibleMessages || isAlertMode || isWidgetFixMode) && (
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
						<PromptInputSubmit status={status} disabled={isLoading} />
					</PromptInputFooter>
				</PromptInput>
			</div>
		</div>
	)
}

function ChatTimelineSection({
	section,
	isLoading,
	isLastSection,
	answeredApprovals,
	onApprovalResponse,
}: {
	section: EntityTimelineSection
	isLoading: boolean
	isLastSection: boolean
	answeredApprovals: ReadonlySet<string>
	onApprovalResponse: (approvalId: string, approved: boolean) => void | PromiseLike<void>
}) {
	if (section.kind === "user_message") {
		return (
			<Message from="user">
				<MessageContent>
					<RichText>{section.text}</RichText>
				</MessageContent>
			</Message>
		)
	}

	return (
		<Message from="assistant">
			<MessageContent>
				{section.items.map((item, i) => {
					if (item.kind === "text") {
						return <RichText key={i}>{item.text}</RichText>
					}

					const approval = parseApprovalResult(item.result)
					if (
						item.status === "completed" &&
						requiresApproval(item.toolName) &&
						approval?.approvalId &&
						!answeredApprovals.has(approval.approvalId)
					) {
						return (
							<ApprovalCard
								key={item.toolCallId}
								toolName={item.toolName}
								input={item.args}
								approvalId={approval.approvalId}
								onApprove={(id) => onApprovalResponse(id, true)}
								onDeny={(id) => onApprovalResponse(id, false)}
							/>
						)
					}

					return (
						<Tool
							key={item.toolCallId}
							toolName={item.toolName}
							toolCallId={item.toolCallId}
							state={mapToolStatus(item.status)}
							input={item.args}
							output={item.result}
							errorText={item.isError ? item.result : undefined}
						/>
					)
				})}
				{isLoading && isLastSection && !section.done && <ThinkingIndicator />}
				{section.error ? <RichText>{section.error}</RichText> : null}
			</MessageContent>
		</Message>
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
