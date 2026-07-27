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
import { PageContextChips } from "./page-context-chips"
import { ChatTranscript, findDiagnosisMessageId } from "./chat-transcript"
import {
	PromptInput,
	PromptInputTextarea,
	PromptInputFooter,
	PromptInputSubmit,
} from "@/components/ai-elements/prompt-input"
import { Suggestions, Suggestion } from "@/components/ai-elements/suggestion"
import { makeChatApplyPayload } from "./chat-apply-payload"
import type { AiTriageResult } from "@maple/domain/http"


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
	/** Preserved DB report for migrated/pruned conversations without a tool marker. */
	fallbackDiagnosis?: AiTriageResult | null
	/** Message to open the transcript on, from a `?m=` permalink. */
	focusMessageId?: string
	/** Builds a shareable permalink for a message; omit where the thread isn't shareable. */
	permalinkFor?: (messageId: string) => string
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
	fallbackDiagnosis = null,
	focusMessageId,
	permalinkFor,
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
	const diagnosisMessageId = useMemo(() => findDiagnosisMessageId(messages), [messages])

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
			<ChatTranscript
				messages={messages}
				isLoading={isLoading}
				resolvedApprovals={resolvedApprovals}
				onApprove={handleApprove}
				onDeny={(toolCallId) => resolveApproval(toolCallId, "denied")}
				fallbackDiagnosis={fallbackDiagnosis && !diagnosisMessageId ? fallbackDiagnosis : null}
				diagnosisMessageId={diagnosisMessageId}
				focusMessageId={focusMessageId}
				permalinkFor={permalinkFor}
				readOnly={readOnly}
				emptyState={
					!hasSettled ? (
						<ConversationLoadingSkeleton />
					) : readOnly ? (
						<EmptyNotice title="Shared conversation">
							This shared conversation is unavailable or empty. It may have been deleted, or
							belong to a different workspace than the one you're signed in to.
						</EmptyNotice>
					) : isInvestigationMode ? (
						<EmptyNotice title="Ready to investigate">
							The {investigationNoun(investigationContext!.kind)} above is attached to every
							message in this thread. Start with a suggestion or ask your own question.
						</EmptyNotice>
					) : isWidgetFixMode ? (
						<EmptyNotice title="Diagnosing widget…">
							Maple AI is reading the broken widget config and the validation error. It will
							propose a corrected widget JSON for you to approve.
						</EmptyNotice>
					) : (
						<div className="flex flex-col items-center gap-3">
							<div className="space-y-1 text-center">
								<h3 className="font-medium text-sm">Maple AI</h3>
								<p className="text-muted-foreground text-sm">
									Ask me about your traces, logs, errors, and services.
								</p>
							</div>
							<Suggestions className="mt-2 justify-center">
								{suggestions.map((s) => (
									<Suggestion key={s} suggestion={s} onClick={() => handleSend(s)} />
								))}
							</Suggestions>
						</div>
					)
				}
			/>

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
							<PromptInputSubmit status={status} disabled={isLoading} />
						</PromptInputFooter>
					</PromptInput>
				</div>
			)}
		</div>
	)
}


function EmptyNotice({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 text-center">
			<p className="text-xs uppercase tracking-[0.14em] text-muted-foreground/70">{title}</p>
			<p className="max-w-sm text-sm text-muted-foreground">{children}</p>
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
