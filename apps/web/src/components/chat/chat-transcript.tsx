import type { ReactNode } from "react"

import { Button } from "@maple/ui/components/ui/button"
import { Bubble, BubbleContent } from "@maple/ui/components/ui/bubble"
import { Marker, MarkerContent } from "@maple/ui/components/ui/marker"
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
	useMessageScroller,
	useMessageScrollerVisibility,
} from "@maple/ui/components/ui/message-scroller"
import { Message, MessageContent, MessageFooter } from "@maple/ui/components/ui/message"
import { useMountEffect } from "@/hooks/use-mount-effect"
import { PulseIcon } from "@/components/icons"
import { RichText } from "@/components/ai-elements/rich-text"
import { StatusMarker } from "@/components/ai-elements/status-marker"
import { Tool, ToolRow, toolLabel } from "@/components/ai-elements/tool"
import { ToolGroup } from "@/components/ai-elements/tool-group"
import { ApprovalCard } from "./approval-card"
import { DiagnosisReportCard } from "./diagnosis-report-card"
import { MessageActions, messageText } from "./message-actions"
import { parseDiagnosisMarker } from "./diagnosis-marker"
import { parseToolProposal } from "./tool-proposal"
import { stripContextPreamble } from "./context-preamble"
import {
	buildTranscriptRows,
	deriveToolStatus,
	isToolPart,
	toolNameFor,
	toolPartsOf,
	type ToolPart,
} from "./transcript-rows"
import type { UIMessage } from "@/components/ai-elements/types"
import type { AiTriageResult } from "@maple/domain/http"

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

/** The id of the message carrying a diagnosis report, if the thread produced one. */
export function findDiagnosisMessageId(messages: readonly UIMessage[]): string | undefined {
	for (const message of messages) {
		for (const part of message.parts) {
			if (!isToolPart(part)) continue
			const tp = part as ToolPart
			if (tp.state === "output-available" && parseDiagnosisMarker(tp.output)) return message.id
		}
	}
	return undefined
}

/**
 * A buffer of tool calls → one card: a bare row when there's a single call, a
 * collapsed `Used N tools` group when there are several. Shared by the two callers
 * that produce tool cards — the within-message flush below and the merged tool-run
 * row — so a burst looks the same however it arrived.
 */
function renderToolNodes(buf: readonly ToolPart[], keyHint: string): ReactNode {
	if (buf.length === 0) return null
	if (buf.length === 1) {
		const t = buf[0]!
		return (
			<Tool
				key={t.toolCallId ?? keyHint}
				toolName={toolNameFor(t)}
				toolCallId={t.toolCallId}
				state={t.state}
				input={t.input}
				output={t.output}
				errorText={t.errorText}
			/>
		)
	}
	const runningCount = buf.filter((t) => deriveToolStatus(t.state) === "running").length
	const errorCount = buf.filter((t) => deriveToolStatus(t.state) === "error").length
	const lastRunning = [...buf].reverse().find((t) => deriveToolStatus(t.state) === "running")
	return (
		<ToolGroup
			key={`group-${buf[0]!.toolCallId ?? keyHint}`}
			count={buf.length}
			runningCount={runningCount}
			errorCount={errorCount}
			completedCount={buf.length - runningCount}
			currentLabel={lastRunning ? toolLabel(toolNameFor(lastRunning)) : undefined}
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
		</ToolGroup>
	)
}

interface RenderPartsOptions {
	message: UIMessage
	resolvedApprovals: Map<string, "applied" | "denied">
	onApprove: (toolCallId: string, tool: string, input: unknown) => void
	onDeny: (toolCallId: string) => void
}

/**
 * Message parts → nodes. Consecutive tool calls are buffered so a burst collapses
 * into a single `ToolGroup` header instead of a wall of cards; a text part (or a
 * card-worthy tool output) flushes the buffer and keeps the original ordering.
 */
function renderMessageParts({
	message,
	resolvedApprovals,
	onApprove,
	onDeny,
}: RenderPartsOptions): ReactNode[] {
	const nodes: ReactNode[] = []
	let toolBuf: ToolPart[] = []

	const flushTools = () => {
		if (toolBuf.length === 0) return
		const buf = toolBuf
		toolBuf = []
		nodes.push(renderToolNodes(buf, `tool-${nodes.length}`))
	}

	for (let i = 0; i < message.parts.length; i++) {
		const part = message.parts[i]!
		if (part.type === "text") {
			flushTools()
			// Context the model needs but the reader doesn't — see `wrapChatContext`.
			const text = stripContextPreamble(part.text)
			if (text) nodes.push(<RichText key={`text-${i}`}>{text}</RichText>)
			continue
		}
		if (!isToolPart(part)) continue

		const tp = part as ToolPart
		const diagnosis = tp.state === "output-available" ? parseDiagnosisMarker(tp.output) : null
		if (diagnosis) {
			flushTools()
			nodes.push(
				<DiagnosisReportCard key={tp.toolCallId ?? `diagnosis-${i}`} report={diagnosis.report} />,
			)
			continue
		}
		const proposal = tp.state === "output-available" ? parseToolProposal(tp.output) : null
		if (proposal) {
			flushTools()
			nodes.push(
				<ApprovalCard
					key={tp.toolCallId ?? `approval-${i}`}
					toolName={proposal.tool}
					input={proposal.input}
					resolved={resolvedApprovals.get(tp.toolCallId)}
					onApprove={() => onApprove(tp.toolCallId, proposal.tool, proposal.input)}
					onDeny={() => onDeny(tp.toolCallId)}
				/>,
			)
			continue
		}
		toolBuf.push(tp)
	}
	flushTools()
	return nodes
}

/**
 * `MessageScrollerItem` ships `content-visibility: auto`, which imposes size
 * containment while a row is off-screen. Maple's transcript is full of content that
 * settles its height *after* mount — mermaid, KaTeX, and the lazily-loaded structured
 * tool renderers — and size containment over churning geometry is what produced the
 * scrollTop-clamping jank documented in `@maple/ui`'s `CollapsiblePanel`. Threads here
 * run to tens of rows, not thousands, so skipping off-screen paint buys little; we opt
 * out at the call site and leave the primitive registry-pristine.
 */
const TRANSCRIPT_ITEM = "[content-visibility:visible] [contain-intrinsic-size:none]"

/**
 * The one knob for the rhythm *inside* a turn. Parts used to carry their own `my-2`,
 * which the bubble's `overflow-hidden` block formatting context trapped — so every
 * card also padded the bubble's top and bottom edges on top of the list gap. A real
 * flex gap spaces siblings and leaves the edges alone.
 */
const PART_STACK = "flex flex-col gap-2"

export interface ChatTranscriptProps {
	messages: readonly UIMessage[]
	isLoading: boolean
	resolvedApprovals: Map<string, "applied" | "denied">
	onApprove: (toolCallId: string, tool: string, input: unknown) => void
	onDeny: (toolCallId: string) => void
	fallbackDiagnosis: AiTriageResult | null
	diagnosisMessageId?: string
	focusMessageId?: string
	permalinkFor?: (messageId: string) => string
	/** Why the thread can't be replied to — the marker says which. */
	readOnly: false | "shared" | "resolved"
	emptyState: ReactNode
}

/**
 * A user turn with nothing left after the context fence is stripped — the prompt
 * `apps/api` sends to open an investigation. Nobody typed it, so it shouldn't
 * appear as though someone did.
 */
const isMachineTurn = (message: UIMessage): boolean =>
	message.role === "user" &&
	message.parts.length > 0 &&
	message.parts.every((part) => part.type === "text" && stripContextPreamble(part.text).length === 0)

/** Leading marker for a thread that can't be continued. */
const READ_ONLY_LABEL: Record<"shared" | "resolved", string> = {
	shared: "Shared conversation · read-only",
	resolved: "Investigation resolved · read-only",
}

/**
 * The scrolling transcript. `MessageScroller` owns the behaviour that used to be
 * `use-stick-to-bottom`'s job plus the parts it never covered: it anchors each new
 * user turn near the top of the viewport (so a long reply reads top-down instead of
 * crawling up from the bottom), keeps position when history is prepended, and exposes
 * `scrollToMessage` for permalinks.
 *
 * Note that `MessageScrollerContent` treats *every* direct child as a transcript item,
 * so anything rendered inside it is wrapped in `MessageScrollerItem` with a stable id.
 * The empty/loading states render instead of the scroller — there's nothing to scroll.
 */
export function ChatTranscript({
	messages,
	isLoading,
	resolvedApprovals,
	onApprove,
	onDeny,
	fallbackDiagnosis,
	diagnosisMessageId,
	focusMessageId,
	permalinkFor,
	readOnly,
	emptyState,
}: ChatTranscriptProps) {
	if (messages.length === 0 && !fallbackDiagnosis) {
		return <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-6">{emptyState}</div>
	}

	const awaitingFirstToken = isLoading && messages[messages.length - 1]?.role === "user"
	const lastMessageId = messages[messages.length - 1]?.id

	return (
		<MessageScrollerProvider autoScroll defaultScrollPosition="end">
			<MessageScroller className="min-h-0 flex-1">
				<MessageScrollerViewport>
					<MessageScrollerContent className="mx-auto w-full max-w-3xl gap-4 px-4 py-6">
						{readOnly ? (
							<MessageScrollerItem messageId="__read-only" className={TRANSCRIPT_ITEM}>
								<Marker variant="separator">
									<MarkerContent>{READ_ONLY_LABEL[readOnly]}</MarkerContent>
								</Marker>
							</MessageScrollerItem>
						) : null}
						{fallbackDiagnosis ? (
							<MessageScrollerItem messageId="__fallback-diagnosis" className={TRANSCRIPT_ITEM}>
								<DiagnosisReportCard report={fallbackDiagnosis} />
							</MessageScrollerItem>
						) : null}
						{buildTranscriptRows(messages).map((row) => {
							if (row.kind === "tool-run") {
								const last = row.messages[row.messages.length - 1]!
								return (
									<MessageScrollerItem
										key={row.id}
										messageId={row.id}
										className={TRANSCRIPT_ITEM}
									>
										<Message align="start" className="text-sm">
											<MessageContent>
												<Bubble variant="ghost" align="start">
													<BubbleContent className="text-sm">
														<div className={PART_STACK}>
															{renderToolNodes(toolPartsOf(row), row.id)}
															{shouldShowThinkingIndicator(
																last,
																isLoading,
																last.id === lastMessageId,
															) ? (
																<StatusMarker />
															) : null}
														</div>
													</BubbleContent>
												</Bubble>
											</MessageContent>
										</Message>
									</MessageScrollerItem>
								)
							}
							const message = row.message
							const isUser = message.role === "user"
							if (isUser && isMachineTurn(message)) {
								return (
									<MessageScrollerItem
										key={message.id}
										messageId={message.id}
										className={TRANSCRIPT_ITEM}
									>
										<Marker variant="separator">
											<MarkerContent>Investigation started</MarkerContent>
										</Marker>
									</MessageScrollerItem>
								)
							}
							return (
								<MessageScrollerItem
									key={message.id}
									messageId={message.id}
									scrollAnchor={isUser}
									className={TRANSCRIPT_ITEM}
								>
									<Message align={isUser ? "end" : "start"} className="text-sm">
										<MessageContent>
											<Bubble
												variant={isUser ? "secondary" : "ghost"}
												align={isUser ? "end" : "start"}
											>
												<BubbleContent
													className={
														isUser ? "rounded-lg px-4 py-3 text-sm" : "text-sm"
													}
												>
													<div className={PART_STACK}>
														{renderMessageParts({
															message,
															resolvedApprovals,
															onApprove,
															onDeny,
														})}
														{shouldShowThinkingIndicator(
															message,
															isLoading,
															message.id === lastMessageId,
														) ? (
															<StatusMarker />
														) : null}
													</div>
												</BubbleContent>
											</Bubble>
											{/* An empty footer still reserves the height of the
											    hover actions, so only text-bearing turns get one. */}
											{isUser || !messageText(message) ? null : (
												<MessageFooter>
													<MessageActions
														message={message}
														permalink={permalinkFor?.(message.id)}
													/>
												</MessageFooter>
											)}
										</MessageContent>
									</Message>
								</MessageScrollerItem>
							)
						})}
						{awaitingFirstToken ? (
							<MessageScrollerItem messageId="__status" className={TRANSCRIPT_ITEM}>
								<StatusMarker />
							</MessageScrollerItem>
						) : null}
					</MessageScrollerContent>
				</MessageScrollerViewport>
				<MessageScrollerButton />
				{focusMessageId ? <FocusMessageOnMount messageId={focusMessageId} /> : null}
				{diagnosisMessageId ? <JumpToDiagnosis messageId={diagnosisMessageId} /> : null}
			</MessageScroller>
		</MessageScrollerProvider>
	)
}

/**
 * Opens a `?m=` permalink on its message. Mounting is the one-shot: the scroller queues
 * the jump when the target row hasn't rendered yet (history still loading) and flushes it
 * on registration, and queuing also suppresses the default scroll-to-end so the two don't
 * fight. Only rendered when there is a message to focus.
 */
function FocusMessageOnMount({ messageId }: { messageId: string }) {
	const { scrollToMessage } = useMessageScroller()
	useMountEffect(() => {
		scrollToMessage(messageId, { align: "start" })
	})
	return null
}

/**
 * Long investigation threads bury the diagnosis report under the follow-up conversation.
 * Offer a way back, but only while it's actually off-screen — `useMessageScrollerVisibility`
 * runs an IntersectionObserver for as long as it's subscribed, so this is mounted only for
 * threads that produced a report.
 */
function JumpToDiagnosis({ messageId }: { messageId: string }) {
	const { scrollToMessage } = useMessageScroller()
	const { visibleMessageIds } = useMessageScrollerVisibility()
	if (visibleMessageIds.includes(messageId)) return null

	return (
		<Button
			size="sm"
			variant="outline"
			className="absolute bottom-4 start-4 max-w-[45%] rounded-full bg-background shadow-sm"
			onClick={() => scrollToMessage(messageId, { align: "start", behavior: "smooth" })}
		>
			<PulseIcon className="size-3.5" />
			<span className="truncate">Jump to diagnosis</span>
		</Button>
	)
}
