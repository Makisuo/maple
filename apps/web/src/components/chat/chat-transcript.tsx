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
import { MessageActions } from "./message-actions"
import { parseDiagnosisMarker } from "./diagnosis-marker"
import { parseToolProposal } from "./tool-proposal"
import type { UIMessage } from "@/components/ai-elements/types"
import type { AiTriageResult } from "@maple/domain/http"

type ToolPart = {
	type: string
	toolCallId: string
	toolName?: string
	state: string
	input?: unknown
	output?: unknown
	errorText?: string
}

export function isToolPart(part: UIMessage["parts"][number]): boolean {
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
		const runningCount = buf.filter((t) => deriveToolStatus(t.state) === "running").length
		const errorCount = buf.filter((t) => deriveToolStatus(t.state) === "error").length
		const lastRunning = [...buf].reverse().find((t) => deriveToolStatus(t.state) === "running")
		nodes.push(
			<ToolGroup
				key={`group-${buf[0]!.toolCallId ?? nodes.length}`}
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
			</ToolGroup>,
		)
	}

	for (let i = 0; i < message.parts.length; i++) {
		const part = message.parts[i]!
		if (part.type === "text") {
			flushTools()
			nodes.push(<RichText key={`text-${i}`}>{part.text}</RichText>)
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
	readOnly: boolean
	emptyState: ReactNode
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

	return (
		<MessageScrollerProvider autoScroll defaultScrollPosition="end">
			<MessageScroller className="min-h-0 flex-1">
				<MessageScrollerViewport>
					<MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6">
						{readOnly ? (
							<MessageScrollerItem messageId="__shared" className={TRANSCRIPT_ITEM}>
								<Marker variant="separator">
									<MarkerContent>Shared conversation · read-only</MarkerContent>
								</Marker>
							</MessageScrollerItem>
						) : null}
						{fallbackDiagnosis ? (
							<MessageScrollerItem messageId="__fallback-diagnosis" className={TRANSCRIPT_ITEM}>
								<DiagnosisReportCard report={fallbackDiagnosis} />
							</MessageScrollerItem>
						) : null}
						{messages.map((message, messageIndex) => {
							const isUser = message.role === "user"
							const permalink = permalinkFor?.(message.id)
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
													{renderMessageParts({
														message,
														resolvedApprovals,
														onApprove,
														onDeny,
													})}
													{shouldShowThinkingIndicator(
														message,
														isLoading,
														messageIndex === messages.length - 1,
													) ? (
														<StatusMarker className="mt-1" />
													) : null}
												</BubbleContent>
											</Bubble>
											{isUser ? null : (
												<MessageFooter>
													<MessageActions message={message} permalink={permalink} />
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