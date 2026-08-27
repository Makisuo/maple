import { useMemo, useRef, useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Schema } from "effect"

import { SpanId, TraceId } from "@maple/domain"
import type { AiSessionSpan } from "@maple/domain/http"
import { ErrorSection } from "@maple/ui/components/error-section"
import { Button } from "@maple/ui/components/ui/button"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import {
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleWarningIcon,
	CopyIcon,
	ExternalLinkIcon,
} from "@/components/icons"
import { MessageResponse } from "@/components/ai-elements/message-response"
import { AttributesSection, CopyableValue, ResourceAttributesSection } from "@/components/attributes"
import { SpanLogs } from "@/components/traces/span-detail-panel"
import type { SpanDetailResult } from "@/api/warehouse/traces"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { disabledResultAtom } from "@/lib/services/atoms/disabled-result-atom"
import { getSpanDetailResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { formatTimestampInTimezone } from "@/lib/timezone-format"
import {
	spanMessages,
	spanToolCalls,
	type SessionToolResults,
	type SpanMessage,
	type SpanMessagePart,
	type SpanToolCall,
} from "@/lib/agent-sessions/span-detail"
import { classifyAiSpan, spanFailed, spanTtftMs } from "@/lib/agent-sessions/session-turns"
import { callMetaLine, formatCost } from "@/lib/agent-sessions/session-summary"
import { ClampedText, firstLine } from "./clamped-text"
import { useJsonPayload, ViewSegment, ViewSwitch } from "./payload-view"
import { Pill } from "./pill"

/**
 * The payload of one span. The chrome around it is the caller's — today that is
 * `SpanPopover`, which every view opens against whatever the reader clicked —
 * and it reaches this body through `header`.
 */

export type SpanDetailTab = "details" | "messages" | "tools" | "logs"

export function SpanExpansion({
	span,
	header,
	tab,
	onTabChange,
	toolResults,
}: {
	span: AiSessionSpan
	/** Rendered above the tab strip. */
	header?: ReactNode
	/** The reader's tab choice, held by SessionViews so it survives switching
	 *  spans and views; `undefined` means none made yet — pick by content. */
	tab: SpanDetailTab | undefined
	onTabChange: (tab: SpanDetailTab) => void
	/** The session's captured tool results by call id (`sessionToolResults`),
	 *  so each call shows its response even when another span reported it. */
	toolResults?: SessionToolResults
}) {
	const messages = useMemo(() => spanMessages(span), [span])
	const toolCalls = useMemo(() => spanToolCalls(span, toolResults), [span, toolResults])

	// Until the reader picks a tab, each span opens on its own payload: an
	// errored span on its error, a model call on its messages, a tool call on
	// its arguments. An explicit choice then holds across spans and views.
	const active: SpanDetailTab =
		tab ??
		(spanFailed(span)
			? "details"
			: messages.length > 0
				? "messages"
				: toolCalls.length > 0
					? "tools"
					: "details")

	const tabs = (
		<div className="flex items-center gap-1">
			<TabButton active={active === "details"} onClick={() => onTabChange("details")}>
				Details
			</TabButton>
			<TabButton
				active={active === "messages"}
				onClick={() => onTabChange("messages")}
				count={messages.length}
			>
				Messages
			</TabButton>
			<TabButton
				active={active === "tools"}
				onClick={() => onTabChange("tools")}
				count={toolCalls.length}
			>
				Tool calls
			</TabButton>
			<TabButton active={active === "logs"} onClick={() => onTabChange("logs")}>
				Logs
			</TabButton>
		</div>
	)

	return (
		<div className="flex min-w-0 flex-col text-left">
			{header}
			<div className="flex flex-wrap items-center gap-2 border-border border-b pb-1.5">
				{tabs}
				<div className="ml-auto flex items-center gap-2">
					<CopySpanJsonButton span={span} />
					<OpenInTracesLink span={span} />
				</div>
			</div>

			<MetaStrip span={span} />

			{active === "details" && <DetailsSection span={span} toolCalls={toolCalls} />}
			{active === "messages" && <MessagesSection messages={messages} span={span} />}
			{active === "tools" && <ToolCallsSection toolCalls={toolCalls} />}
			{active === "logs" && <LogsSection span={span} />}
		</div>
	)
}

function TabButton({
	active,
	onClick,
	count,
	children,
}: {
	active: boolean
	onClick: () => void
	count?: number
	children: string
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={cn(
				"flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs",
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				active
					? "bg-muted font-medium text-foreground"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
			{count !== undefined && count > 0 && (
				<span className="font-mono text-[10px] text-muted-foreground tabular-nums">{count}</span>
			)}
		</button>
	)
}

function CopySpanJsonButton({ span }: { span: AiSessionSpan }) {
	const [copied, setCopied] = useState(false)
	const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

	return (
		<Button
			variant="outline"
			size="sm"
			className="h-6.5 gap-1.5 text-xs"
			onClick={() => {
				void navigator.clipboard?.writeText(JSON.stringify(span, null, 2))
				setCopied(true)
				clearTimeout(timeoutRef.current)
				timeoutRef.current = setTimeout(() => setCopied(false), 1500)
			}}
		>
			{copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
			Copy JSON
		</Button>
	)
}

function OpenInTracesLink({ span }: { span: AiSessionSpan }) {
	return (
		<Button
			variant="outline"
			size="sm"
			className="h-6.5 gap-1.5 text-xs"
			render={
				<Link
					to="/traces/$traceId"
					params={{ traceId: span.traceId }}
					search={{ t: span.timestamp, spanId: span.spanId }}
				/>
			}
		>
			Open in Traces
			<ExternalLinkIcon size={11} />
		</Button>
	)
}

/* -------------------------------------------------------------------------- */
/* Meta strip                                                                 */
/* -------------------------------------------------------------------------- */

/** The call's own settings and identity, shown only where the span reported
 *  them — a strip of dashes would just restate the attribute tab's absences. */
function MetaStrip({ span }: { span: AiSessionSpan }) {
	const { effectiveTimezone } = useTimezonePreference()
	const ttftMs = spanTtftMs(span)

	const pairs: readonly (readonly [string, ReactNode])[] = [
		["provider", span.genAi.providerName],
		[
			"started",
			formatTimestampInTimezone(span.timestamp, {
				timeZone: effectiveTimezone,
				withMilliseconds: true,
			}),
		],
		["ttft", ttftMs === undefined ? undefined : formatDuration(ttftMs)],
		[
			"max_tokens",
			span.genAi.requestMaxTokens === undefined ? undefined : formatNumber(span.genAi.requestMaxTokens),
		],
		["temperature", span.genAi.requestTemperature],
		[
			"cost",
			span.genAi.usageCost === undefined ? undefined : (
				<span className="text-primary">{formatCost(span.genAi.usageCost)}</span>
			),
		],
	]

	return (
		<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5">
			{pairs.map(([label, value]) =>
				value === undefined ? null : (
					<span key={label} className="flex items-baseline gap-1.5">
						<span className="text-[11px] text-muted-foreground">{label}</span>
						<span className="font-mono text-foreground text-xs">{value}</span>
					</span>
				),
			)}
			<span className="ml-auto flex items-baseline gap-1.5 font-mono text-[11px] text-muted-foreground/70">
				<CopyableValue value={span.spanId} label="Span ID">
					span {span.spanId}
				</CopyableValue>
				<span aria-hidden>·</span>
				<CopyableValue value={span.traceId} label="Trace ID">
					trace {span.traceId.slice(0, 8)}…{span.traceId.slice(-4)}
				</CopyableValue>
			</span>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

const ROLE_TEXT = {
	system: "text-muted-foreground",
	user: "text-primary",
	assistant: "text-chart-2",
	tool: "text-chart-4",
} as const

function roleColor(role: string): string {
	return ROLE_TEXT[role.toLowerCase() as keyof typeof ROLE_TEXT] ?? "text-muted-foreground"
}

function MessagesSection({ messages, span }: { messages: readonly SpanMessage[]; span: AiSessionSpan }) {
	if (messages.length === 0) {
		return (
			<EmptyNote>
				No messages were captured on this span — message capture is opt-in and off by default.
			</EmptyNote>
		)
	}
	return (
		<div className="flex flex-col gap-4 pb-1">
			{messages.map((message, index) =>
				// By role, not origin: a system message inside the input history
				// repeats on every call exactly like standalone instructions do.
				message.role.toLowerCase() === "system" ? (
					<SystemMessageRow key={index} message={message} />
				) : (
					<MessageBlock key={index} message={message} span={span} />
				),
			)}
		</div>
	)
}

/** System instructions collapse to one line: they repeat on every call and are
 *  rarely what the reader came for. */
function SystemMessageRow({ message }: { message: SpanMessage }) {
	const [open, setOpen] = useState(false)
	const [raw, setRaw] = useState(false)
	const text = collapsedText(message.parts)

	return (
		<div className="rounded-md border border-border/60 bg-muted/30">
			<button
				type="button"
				onClick={() => setOpen((previous) => !previous)}
				aria-expanded={open}
				className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left"
			>
				{open ? (
					<ChevronDownIcon size={11} className="shrink-0 text-muted-foreground" />
				) : (
					<ChevronRightIcon size={11} className="shrink-0 text-muted-foreground" />
				)}
				<span className="shrink-0 font-medium font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
					{message.role}
				</span>
				{!open && (
					<span className="min-w-0 truncate text-muted-foreground text-xs">{firstLine(text)}</span>
				)}
			</button>
			{open && (
				<div className="flex items-start gap-1.5 px-2.5 pb-2.5 pl-8">
					<div className="min-w-0 grow">
						<ClampedText
							text={text}
							body={raw ? undefined : <MessageResponse className="text-sm">{text}</MessageResponse>}
						/>
					</div>
					<ViewSwitch rendered="md" raw={raw} onRawChange={setRaw} />
					{/* Copies the instructions as captured, not their rendering. */}
					<CopyButton value={text} label="system message" className="-my-1 shrink-0" />
				</div>
			)}
		</div>
	)
}

function MessageBlock({ message, span }: { message: SpanMessage; span: AiSessionSpan }) {
	// One rendered ↔ raw choice per message: its text parts are one body the
	// reader flips together, while the payload cards keep their own json switch.
	const [raw, setRaw] = useState(false)
	const hasText = message.parts.some((part) => part.kind === "text")

	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<div className="flex items-center gap-2.5">
				<span
					className={cn(
						"shrink-0 font-medium font-mono text-[10px] uppercase tracking-widest",
						roleColor(message.role),
					)}
				>
					{message.role}
				</span>
				{/* Output messages are what this call produced, so the call's own
				    response facts belong on them and on nothing else. */}
				{message.origin === "output" && (
					<span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">
						{callMetaLine(span)}
					</span>
				)}
				<span aria-hidden className="h-px min-w-4 flex-1 bg-border/60" />
				{hasText && <ViewSwitch rendered="md" raw={raw} onRawChange={setRaw} />}
			</div>
			<div className="flex min-w-0 flex-col gap-2">
				{message.parts.map((part, index) => (
					<MessagePart key={index} part={part} raw={raw} />
				))}
			</div>
		</div>
	)
}

function MessagePart({ part, raw }: { part: SpanMessagePart; raw: boolean }) {
	if (part.kind === "text") {
		return (
			<ClampedText
				text={part.text}
				body={raw ? undefined : <MessageResponse className="text-sm">{part.text}</MessageResponse>}
			/>
		)
	}
	if (part.kind === "reasoning") return <ReasoningPart part={part} />
	if (part.kind === "tool_call") {
		return <PayloadCard label="tool_call" name={part.name} meta={part.id} body={part.argumentsText} />
	}
	return <PayloadCard label="tool_result" meta={part.id} body={part.resultText} />
}

/** Reasoning is the model thinking, not the model answering, so it is set apart
 *  rather than run in with the reply above it. */
function ReasoningPart({ part }: { part: Extract<SpanMessagePart, { kind: "reasoning" }> }) {
	return (
		<div className="min-w-0 border-chart-5/50 border-l-2 pl-2.5">
			<span className="font-medium font-mono text-[10px] text-chart-5 uppercase tracking-widest">
				Reasoning
			</span>
			{part.redacted || part.text === undefined ? (
				<p className="text-muted-foreground text-xs italic">
					{part.redacted
						? "Redacted by the provider — the reasoning was returned sealed."
						: "No reasoning text was captured."}
				</p>
			) : (
				<ClampedText text={part.text} />
			)}
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Tool calls                                                                 */
/* -------------------------------------------------------------------------- */

function ToolCallsSection({ toolCalls }: { toolCalls: readonly SpanToolCall[] }) {
	if (toolCalls.length === 0) {
		return <EmptyNote>No tool calls were captured on this span.</EmptyNote>
	}
	return (
		<div className="flex flex-col gap-3 pb-1">
			{toolCalls.map((call, index) => (
				<ToolCallCard key={index} call={call} />
			))}
		</div>
	)
}

/**
 * One invocation as one card: the call and its result belong to the same event,
 * and two stacked cards made the reader pair them by eye. A selector shows one
 * half at a time — the other stays a click away, never a scroll.
 */
function ToolCallCard({ call }: { call: SpanToolCall }) {
	const [side, setSide] = useState<"arguments" | "result">(
		call.argumentsText === undefined && call.resultText !== undefined ? "result" : "arguments",
	)
	const body = side === "arguments" ? call.argumentsText : call.resultText

	return (
		<div className="min-w-0 overflow-hidden rounded-md border border-border/70">
			<div className="flex items-center gap-2 bg-muted/40 px-2.5 py-1.5">
				<span aria-hidden className="size-1.5 shrink-0 rounded-xs bg-chart-4" />
				<span className="shrink-0 font-medium font-mono text-chart-4 text-xs">tool</span>
				{call.name !== undefined && (
					<span className="min-w-0 truncate font-mono text-foreground text-xs" title={call.name}>
						{call.name}
					</span>
				)}
				<span className="ml-auto flex shrink-0 items-center gap-2">
					{call.id !== undefined && (
						<span className="max-w-40 truncate font-mono text-[11px] text-muted-foreground/80" title={call.id}>
							{call.id}
						</span>
					)}
					<span
						role="group"
						aria-label="Tool payload"
						className="flex shrink-0 items-center overflow-hidden rounded-sm border border-border"
					>
						<ViewSegment active={side === "arguments"} onSelect={() => setSide("arguments")}>
							arguments
						</ViewSegment>
						<ViewSegment active={side === "result"} onSelect={() => setSide("result")}>
							result
						</ViewSegment>
					</span>
				</span>
			</div>
			{call.description !== undefined && (
				<p className="border-border/60 border-t px-2.5 py-1.5 text-muted-foreground text-xs">
					{call.description}
				</p>
			)}
			{body === undefined ? (
				<p className="border-border/60 border-t bg-background/50 px-2.5 py-2 text-muted-foreground text-xs italic">
					{side === "arguments"
						? "No arguments were captured for this call."
						: "No result was captured — whether the call succeeded is unknown."}
				</p>
			) : (
				<PayloadBody text={body} copyLabel={side} />
			)}
		</div>
	)
}

function PayloadCard({
	label,
	name,
	meta,
	description,
	body,
}: {
	label: string
	name?: string | undefined
	meta?: string | undefined
	description?: string | undefined
	body?: string | undefined
}) {
	return (
		<div className="min-w-0 overflow-hidden rounded-md border border-border/70">
			<div className="flex items-center gap-2 bg-muted/40 px-2.5 py-1.5">
				<span aria-hidden className="size-1.5 shrink-0 rounded-xs bg-chart-4" />
				<span className="shrink-0 font-medium font-mono text-chart-4 text-xs">{label}</span>
				{name !== undefined && (
					<span className="min-w-0 truncate font-mono text-foreground text-xs">{name}</span>
				)}
				{meta !== undefined && (
					<span className="ml-auto min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">
						{meta}
					</span>
				)}
			</div>
			{description !== undefined && (
				<p className="border-border/60 border-t px-2.5 py-1.5 text-muted-foreground text-xs">
					{description}
				</p>
			)}
			{body !== undefined && <PayloadBody text={body} copyLabel={label} />}
		</div>
	)
}

/**
 * A payload card's body: pretty-printed and highlighted where it parses as
 * JSON, with the same json ↔ raw switch the transcript's cards carry — the
 * captured bytes stay one click away, and the copy takes what is displayed.
 */
function PayloadBody({ text, copyLabel }: { text: string; copyLabel: string }) {
	const { formatted, highlighted } = useJsonPayload(text)
	const [raw, setRaw] = useState(false)

	return (
		<div className="flex items-start gap-1.5 border-border/60 border-t bg-background/50 px-2.5 py-2">
			<div className="min-w-0 grow">
				<ClampedText text={raw ? text : formatted} html={raw ? undefined : highlighted} mono />
			</div>
			{highlighted !== undefined && (
				<ViewSwitch rendered="json" raw={raw} onRawChange={setRaw} className="self-start" />
			)}
			<CopyButton value={raw ? text : formatted} label={copyLabel} className="-my-1 shrink-0" />
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Details                                                                    */
/* -------------------------------------------------------------------------- */

const toTraceId = Schema.decodeSync(TraceId)
const toSpanId = Schema.decodeSync(SpanId)

/**
 * The same reading the trace page's span panel gives: the span's error, its
 * identity and timing, and the full span/resource attribute maps rendered
 * through the shared attribute sections. The maps are fetched here — the
 * session endpoint drops them server-side, so this is the panel's own lazy
 * `spanDetail` read, made once the tab is open.
 *
 * A FAILED span leads with its failure, whatever form the span reported it in:
 * the status message where there is one, otherwise the attributes the failure
 * was read from — Details is where a reader looks first, and a failed call
 * whose evidence is only on another tab reads as a call that did not fail.
 */
function DetailsSection({
	span,
	toolCalls,
}: {
	span: AiSessionSpan
	toolCalls: readonly SpanToolCall[]
}) {
	const detailResult = useAtomValue(
		span.traceId !== "" && span.spanId !== ""
			? getSpanDetailResultAtom({
					data: {
						traceId: toTraceId(span.traceId),
						spanId: toSpanId(span.spanId),
						timestamp: span.timestamp,
					},
				})
			: disabledResultAtom<SpanDetailResult>(),
	)
	const detailAttrs = Result.isSuccess(detailResult) ? detailResult.value : undefined

	const failed = spanFailed(span)
	// A failed tool call's captured result is usually where the actual error
	// text lives; surfacing it here saves the reader the trip to the Tool calls
	// tab. Tool spans only — a model span's tool calls are its OUTPUT, and their
	// results say nothing about why the model call itself failed. The own call
	// is first in `spanToolCalls`' order.
	const failedToolResult =
		failed && classifyAiSpan(span) === "tool" ? toolCalls[0]?.resultText : undefined

	return (
		<div className="flex flex-col gap-3 pb-1">
			{failed &&
				(span.statusMessage !== "" ? (
					<ErrorSection
						message={span.statusMessage}
						badge={span.genAi.errorType}
						prompt={{
							serviceName: span.serviceName,
							operation: span.spanName,
							attributes: detailAttrs?.spanAttributes,
						}}
						className="mx-0 my-0"
					/>
				) : (
					<FailureBanner span={span} />
				))}
			{failedToolResult !== undefined && (
				<PayloadCard
					label="result"
					name={toolCalls[0]?.name}
					meta={span.statusCode === "Error" ? "span status Error" : undefined}
					body={failedToolResult}
				/>
			)}
			<IdentityRows span={span} />
			{Result.builder(detailResult)
				.onInitial(() => (
					<div className="flex flex-col gap-2">
						<Skeleton className="h-4 w-32" />
						<Skeleton className="h-24 w-full" />
						<Skeleton className="h-4 w-32" />
						<Skeleton className="h-24 w-full" />
					</div>
				))
				.onError(() => <EmptyNote>Failed to load this span's full attributes.</EmptyNote>)
				.onSuccess((detail) => (
					<>
						<AttributesSection attributes={detail.spanAttributes} title="Span Attributes" />
						<ResourceAttributesSection attributes={detail.resourceAttributes} />
					</>
				))
				.render()}
		</div>
	)
}

/**
 * The failure of a span that recorded no status message. The pills name the
 * attributes the failure was actually read from — the same evidence
 * `spanFailed` reads — because with no message, saying WHERE the claim comes
 * from is all the banner can honestly do.
 */
function FailureBanner({ span }: { span: AiSessionSpan }) {
	const errorType = span.genAi.errorType
	const responseStatus = span.genAi.responseStatus

	return (
		<div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5">
			<div className="flex flex-wrap items-center gap-2">
				<CircleWarningIcon size={13} className="shrink-0 text-destructive" />
				<span className="font-medium text-[13px] text-destructive">This call failed</span>
				{span.statusCode === "Error" && (
					<Pill tone="error" className="font-mono normal-case tracking-normal">
						span status Error
					</Pill>
				)}
				{errorType !== undefined && errorType !== "" && (
					<Pill tone="error" className="font-mono normal-case tracking-normal">
						error.type {errorType}
					</Pill>
				)}
				{/* Only where it is the evidence: with a status or an error type above,
				    restating the response status would just be noise beside them. */}
				{span.statusCode !== "Error" &&
					(errorType === undefined || errorType === "") &&
					responseStatus !== undefined && (
						<Pill tone="error" className="font-mono normal-case tracking-normal">
							response.status {responseStatus}
						</Pill>
					)}
			</div>
			<p className="text-muted-foreground text-xs leading-relaxed">
				The span reports the failure through the attributes above; it carries no status message.
			</p>
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Logs                                                                       */
/* -------------------------------------------------------------------------- */

/** The same read the trace page's panel makes, fetched only once this tab is
 *  opened — most expansions never look at logs. */
function LogsSection({ span }: { span: AiSessionSpan }) {
	const { effectiveTimezone } = useTimezonePreference()
	return (
		<div className="overflow-hidden rounded-md border border-border/70">
			<SpanLogs traceId={span.traceId} spanId={span.spanId} timeZone={effectiveTimezone} />
		</div>
	)
}

/** Identity and timing, every value click-to-copy — the Details tab's
 *  counterpart of the trace panel's "Span" card. */
function IdentityRows({ span }: { span: AiSessionSpan }) {
	const { effectiveTimezone } = useTimezonePreference()
	const ttftMs = spanTtftMs(span)

	const rows: readonly (readonly [string, string | undefined])[] = [
		[
			"Started",
			formatTimestampInTimezone(span.timestamp, {
				timeZone: effectiveTimezone,
				withMilliseconds: true,
			}),
		],
		["Duration", formatDuration(span.durationMs)],
		["Time to first token", ttftMs === undefined ? undefined : formatDuration(ttftMs)],
		[
			"Status",
			span.statusMessage === "" ? span.statusCode : `${span.statusCode} · ${span.statusMessage}`,
		],
		["Kind", span.spanKind],
		["Service", span.serviceName],
		["Span ID", span.spanId],
		["Trace ID", span.traceId],
		["Parent span ID", span.parentSpanId === "" ? undefined : span.parentSpanId],
	]

	return (
		<div className="divide-y divide-border/40 overflow-hidden rounded-md border border-border/70">
			{rows.map(([label, value]) =>
				value === undefined ? null : (
					<div key={label} className="flex min-w-0 items-baseline gap-3 px-2.5 py-1.5">
						<span className="w-72 shrink-0 text-muted-foreground text-xs">{label}</span>
						<CopyableValue value={value} className="min-w-0">
							<span className="block truncate font-mono text-xs">{value}</span>
						</CopyableValue>
					</div>
				),
			)}
		</div>
	)
}

/* -------------------------------------------------------------------------- */
/* Shared bits                                                                */
/* -------------------------------------------------------------------------- */

function EmptyNote({ children }: { children: ReactNode }) {
	return <p className="py-6 text-center text-muted-foreground text-sm">{children}</p>
}

/**
 * A message's parts as one preview body.
 *
 * Reasoning is labelled rather than dropped: the module's contract is that
 * everything captured stays visible, and a system message whose only content
 * was a reasoning block would otherwise collapse to an empty row.
 */
function collapsedText(parts: readonly SpanMessagePart[]): string {
	return parts
		.map((part) => {
			if (part.kind === "text") return part.text
			if (part.kind === "reasoning") {
				return part.text === undefined ? "[thinking — no text captured]" : `THINKING\n${part.text}`
			}
			return ""
		})
		.filter((text) => text !== "")
		.join("\n")
		.trim()
}

