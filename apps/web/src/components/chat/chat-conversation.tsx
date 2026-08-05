import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Exit } from "effect"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { toastManager } from "@maple/ui/components/ui/toast"
import { useAtomSet } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { useMapleChat, type FailedSend } from "@/hooks/use-maple-chat"
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
import { StatusMarker } from "@/components/ai-elements/status-marker"
import { Button } from "@maple/ui/components/ui/button"
import { trackProduct } from "@/lib/analytics"
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
	/** Render the conversation with no composer, and say why. */
	readOnly?: false | "shared" | "resolved"
	/**
	 * The backend already seeded this conversation with its subject (an
	 * investigation's autonomous pass sends the snapshot server-side), so the
	 * client must not repeat it in a first-message preamble.
	 */
	subjectSeededByServer?: boolean
	/**
	 * Pin the subject above the thread. Off where the surrounding page already
	 * states the subject — the investigation page's own header does, and repeating
	 * it costs a screenful at the top of every thread.
	 */
	showAttachmentCard?: boolean
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
	subjectSeededByServer = false,
	showAttachmentCard = true,
	fallbackDiagnosis = null,
	focusMessageId,
	permalinkFor,
}: ChatConversationProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const regionRef = useRef<HTMLDivElement>(null)
	// Scoped to this conversation's own region: on a full page (an investigation)
	// a window-wide listener swallows every global shortcut, so typing `?` for the
	// shortcut sheet silently drops a question mark into the composer instead.
	useTypeAnywhereFocus(textareaRef, isActive && !readOnly, regionRef)

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
	// adapter (Flue's `agents.send` carries only a message string). Skipped
	// entirely when the backend seeded the conversation itself — repeating the
	// subject would spend the model's window on context it already has.
	const context = useMemo<ChatContext | undefined>(() => {
		if (subjectSeededByServer) return undefined
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
	}, [subjectSeededByServer, mode, investigationContext, widgetFixContext, activeContexts, referrerPath])

	const { sessionId, messages, status, isLoading, historyReady, failedSends, sendMessage, stop, canStop } =
		useMapleChat({ tabId, context })
	const diagnosisMessageId = useMemo(() => findDiagnosisMessageId(messages), [messages])

	// Apply an approved proposal via Maple's authenticated API (propose-then-apply).
	const applyProposal = useAtomSet(MapleApiAtomClient.mutation("chat", "apply"), {
		mode: "promiseExit",
	})
	const [resolvedApprovals, setResolvedApprovals] = useState<Map<string, "applied" | "denied">>(
		() => new Map(),
	)
	// These three reach `ChatTranscript`'s memoized rows as props, so a fresh identity per render
	// would defeat the memo and re-render the whole transcript on every streamed batch.
	const resolveApproval = useCallback((toolCallId: string, outcome: "applied" | "denied") => {
		setResolvedApprovals((prev) => {
			const next = new Map(prev)
			next.set(toolCallId, outcome)
			return next
		})
	}, [])
	const handleDeny = useCallback(
		(toolCallId: string) => resolveApproval(toolCallId, "denied"),
		[resolveApproval],
	)
	const handleApprove = useCallback(
		async (messageId: string, toolCallId: string, tool: string, input: unknown) => {
			// `sessionId` + `messageId` + `toolCallId` are what let the server settle the proposal in the
			// durable transcript, so the card resolves on every device and the model's next turn knows
			// the mutation happened.
			const exit = await applyProposal({
				payload: makeChatApplyPayload(tool, input, { sessionId, messageId, toolCallId }),
			})
			if (Exit.isSuccess(exit)) {
				if (exit.value.isError) {
					toastManager.add({ title: exit.value.content || `Couldn't apply ${tool}`, type: "error" })
					return
				}
				resolveApproval(toolCallId, "applied")
				toastManager.add({ title: "Change applied", type: "success" })
			} else {
				toastManager.add({ title: `Failed to apply ${tool}`, type: "error" })
			}
		},
		[applyProposal, sessionId, resolveApproval],
	)

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
		// The message text stays out of the event — the transcript already has it,
		// and a prompt is the last thing that should be duplicated into a
		// LowCardinality-adjacent analytics column.
		trackProduct("chat_message_sent", { turn: messages.length === 0 ? "first" : "followup" })
		sendMessage(text.trim())
	}

	// Auto-send the fix prompt once a fresh widget-fix conversation is ready.
	// Mounting the zero-DOM trigger IS the one-shot (see `WidgetFixAutoSendTrigger`):
	// the gate below decides when to fire, replacing the prior ref-latch +
	// `eslint-disable` effect. Sending bumps `messages.length`, which unmounts it.
	const shouldAutoSendWidgetFix =
		!readOnly && isWidgetFixMode && isActive && historyReady && !isLoading && messages.length === 0

	return (
		<div ref={regionRef} className="flex h-full min-h-0 flex-col">
			{shouldAutoSendWidgetFix ? (
				<WidgetFixAutoSendTrigger onFire={() => handleSend(widgetFixAutoPrompt)} />
			) : null}
			{isInvestigationMode && showAttachmentCard && (
				<InvestigationAttachmentCard ctx={investigationContext!} />
			)}
			{isWidgetFixMode && <WidgetFixAttachmentCard ctx={widgetFixContext!} />}
			<ChatTranscript
				messages={messages}
				isLoading={isLoading}
				resolvedApprovals={resolvedApprovals}
				onApprove={handleApprove}
				onDeny={handleDeny}
				fallbackDiagnosis={fallbackDiagnosis && !diagnosisMessageId ? fallbackDiagnosis : null}
				diagnosisMessageId={diagnosisMessageId}
				focusMessageId={focusMessageId}
				permalinkFor={permalinkFor}
				readOnly={readOnly}
				emptyState={
					!historyReady ? (
						<ConversationLoadingSkeleton />
					) : readOnly === "shared" ? (
						<EmptyNotice title="Shared conversation">
							This shared conversation is unavailable or empty. It may have been deleted, or
							belong to a different workspace than the one you're signed in to.
						</EmptyNotice>
					) : readOnly === "resolved" ? (
						<EmptyNotice title="Resolved">
							This investigation was resolved before anything was recorded. Reopen it to pick
							the thread back up.
						</EmptyNotice>
					) : isInvestigationMode ? (
						<InvestigationLead ctx={investigationContext!} />
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
					{failedSends.length > 0 && (
						<FailedSendNotice
							failed={failedSends[failedSends.length - 1]!}
							onRetry={handleSend}
						/>
					)}
					<PromptInput onSubmit={({ text }) => handleSend(text)}>
						<PromptInputTextarea
							ref={textareaRef}
							placeholder={
								isInvestigationMode
									? `Ask about this ${investigationNoun(investigationContext!.kind)}…`
									: isWidgetFixMode
										? "Ask about this widget…"
										: "Ask about your system…"
							}
						/>
						<PromptInputFooter>
							<PromptInputSubmit
								status={status}
								onStop={canStop ? stop : undefined}
								disabled={isLoading && !canStop}
							/>
						</PromptInputFooter>
					</PromptInput>
				</div>
			)}
		</div>
	)
}

/**
 * What an investigation thread says before it has any turns. The subject's own
 * status is the whole answer, so this reads it directly rather than letting the
 * page render a second banner that can disagree with the transcript.
 */
function InvestigationLead({ ctx }: { ctx: InvestigationContext }) {
	if (ctx.status === "investigating") {
		return <StatusMarker>Gathering evidence…</StatusMarker>
	}
	if (ctx.status === "failed") {
		return (
			<EmptyNotice title="Autonomous pass failed">
				Maple couldn't complete the investigation. Retry it from the header, or ask a question to
				continue by hand.
			</EmptyNotice>
		)
	}
	return (
		<EmptyNotice title="Ready to investigate">
			This {investigationNoun(ctx.kind)} is attached to every message in the thread. Start with a
			suggestion or ask your own question.
		</EmptyNotice>
	)
}

/**
 * A send that never reached the server. `useMapleChat` keeps the optimistic
 * message in the transcript rather than dropping it, so the only thing missing is
 * a way to try again.
 */
function FailedSendNotice({ failed, onRetry }: { failed: FailedSend; onRetry: (text: string) => void }) {
	return (
		<div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
			<span className="min-w-0 truncate text-destructive">
				Message not sent — {failed.error.message}
			</span>
			<Button size="sm" variant="outline" onClick={() => onRetry(failed.message)}>
				Try again
			</Button>
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
