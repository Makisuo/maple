import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { Schema } from "effect"

import { SpanId, TraceId } from "@maple/domain"
import type { AiSessionSpan } from "@maple/domain/http"
import { ErrorSection } from "@maple/ui/components/error-section"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"

import {
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CopyIcon,
	ExternalLinkIcon,
	XmarkIcon,
} from "@/components/icons"
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
	type SpanMessage,
	type SpanMessagePart,
	type SpanToolCall,
} from "@/lib/agent-sessions/span-detail"
import { classifyAiSpan, spanFailed, spanModel, spanTtftMs } from "@/lib/agent-sessions/session-turns"
import { CATEGORY_FILL } from "./span-visuals"
import { formatCost } from "./session-overview"

/**
 * The payload of one span, expanded in place — under its waterfall row, or in
 * the Flow view's docked drawer. One component for both because the spec's
 * whole point is that a span reads the same wherever it was opened; only the
 * header differs, and the caller supplies that through `header`.
 */

export type SpanDetailTab = "details" | "messages" | "tools" | "logs"

/** A message body clamps at ~12 lines with a "show full" control: prompts run
 *  to tens of thousands of tokens, and the list has to stay navigable. */
const CLAMP_CLASS = "line-clamp-[12]"

export function SpanExpansion({
	span,
	header,
	tabsInHeader = false,
	tab,
	onTabChange,
	toolResults,
}: {
	span: AiSessionSpan
	/** Rendered above the tabs; receives the tab strip when `tabsInHeader`. */
	header?: (tabs: ReactNode) => ReactNode
	/** Drawer layout: the tab strip rides inside the header row. */
	tabsInHeader?: boolean
	/** The reader's tab choice, held by SessionViews so it survives switching
	 *  spans and views; `undefined` means none made yet — pick by content. */
	tab: SpanDetailTab | undefined
	onTabChange: (tab: SpanDetailTab) => void
	/** The session's captured tool results by call id (`sessionToolResults`),
	 *  so each call shows its response even when another span reported it. */
	toolResults?: ReadonlyMap<string, string>
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
			{header !== undefined && header(tabsInHeader ? tabs : null)}
			{!tabsInHeader && (
				<div className="flex flex-wrap items-center gap-2 border-border border-b pb-1.5">
					{tabs}
					<div className="ml-auto flex items-center gap-2">
						<CopySpanJsonButton span={span} />
						<OpenInTracesLink span={span} />
					</div>
				</div>
			)}

			<MetaStrip span={span} />

			{active === "details" && <DetailsSection span={span} />}
			{active === "messages" && <MessagesSection messages={messages} span={span} />}
			{active === "tools" && <ToolCallsSection toolCalls={toolCalls} />}
			{active === "logs" && <LogsSection span={span} />}
		</div>
	)
}

/** The inline form the Traces view mounts under the selected row. */
export function SpanInlineDetail({
	span,
	tab,
	onTabChange,
	toolResults,
}: {
	span: AiSessionSpan
	tab: SpanDetailTab | undefined
	onTabChange: (tab: SpanDetailTab) => void
	toolResults?: ReadonlyMap<string, string>
}) {
	return (
		<div
			data-slot="span-inline-detail"
			className="border-primary border-l-2 border-border border-b bg-card/40 py-2 pr-3 pl-6"
		>
			<SpanExpansion
				key={span.spanId}
				span={span}
				tab={tab}
				onTabChange={onTabChange}
				toolResults={toolResults}
			/>
		</div>
	)
}

/** The docked drawer the Flow view opens along the bottom of the canvas. */
export function SpanDrawer({
	span,
	turnOrdinal,
	tab,
	onTabChange,
	toolResults,
	onClose,
	onOpenTraceView,
}: {
	span: AiSessionSpan
	/** "Turn 3" / "Segment 2" — where the span lives, for the drawer's title row. */
	turnOrdinal: string | undefined
	tab: SpanDetailTab | undefined
	onTabChange: (tab: SpanDetailTab) => void
	toolResults?: ReadonlyMap<string, string>
	onClose: () => void
	/** Switch to the Traces view with this span still selected. */
	onOpenTraceView: () => void
}) {
	const category = classifyAiSpan(span)
	const errored = spanFailed(span)
	const subtitle = [turnOrdinal, spanModel(span), formatDuration(span.durationMs)]
		.filter((part): part is string => part !== undefined)
		.join(" · ")

	return (
		<div
			data-slot="span-drawer"
			className="max-h-[45vh] overflow-y-auto border-border border-t bg-background px-4 pb-4"
		>
			<SpanExpansion
				key={span.spanId}
				span={span}
				tab={tab}
				onTabChange={onTabChange}
				toolResults={toolResults}
				tabsInHeader
				header={(tabs) => (
					<div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 bg-background py-2">
						<span
							aria-hidden
							className={cn(
								"size-1.5 shrink-0 rounded-xs",
								errored ? "bg-destructive" : CATEGORY_FILL[category],
							)}
						/>
						<span className="font-medium font-mono text-sm">{span.spanName}</span>
						{subtitle !== "" && <span className="text-muted-foreground text-xs">{subtitle}</span>}
						{tabs}
						<div className="ml-auto flex items-center gap-2">
							<CopySpanJsonButton span={span} />
							<Button
								variant="outline"
								size="sm"
								className="h-6.5 text-xs"
								onClick={onOpenTraceView}
							>
								Open in Traces view
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Close span detail"
								onClick={onClose}
							>
								<XmarkIcon size={14} />
							</Button>
						</div>
					</div>
				)}
			/>
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
	const text = message.parts
		.map((part) => (part.kind === "text" ? part.text : ""))
		.join("\n")
		.trim()

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
				<div className="px-2.5 pb-2.5 pl-8">
					<ClampedText text={text} />
				</div>
			)}
		</div>
	)
}

function MessageBlock({ message, span }: { message: SpanMessage; span: AiSessionSpan }) {
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
						{outputMeta(span)}
					</span>
				)}
				<span aria-hidden className="h-px min-w-4 flex-1 bg-border/60" />
			</div>
			<div className="flex min-w-0 flex-col gap-2">
				{message.parts.map((part, index) => (
					<MessagePart key={index} part={part} />
				))}
			</div>
		</div>
	)
}

function outputMeta(span: AiSessionSpan): string {
	const parts: string[] = []
	const model = spanModel(span)
	if (model !== undefined) parts.push(model)
	const ttftMs = spanTtftMs(span)
	if (ttftMs !== undefined) parts.push(`first token ${formatDuration(ttftMs)}`)
	const finish = span.genAi.responseFinishReasons
	if (finish !== undefined && finish.length > 0) parts.push(`stop ${finish.join(", ")}`)
	return parts.join(" · ")
}

function MessagePart({ part }: { part: SpanMessagePart }) {
	if (part.kind === "text") return <ClampedText text={part.text} />
	if (part.kind === "tool_call") {
		return <PayloadCard label="tool_call" name={part.name} meta={part.id} body={part.argumentsText} />
	}
	return <PayloadCard label="tool_result" meta={part.id} body={part.resultText} />
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
				<div key={index} className="flex flex-col gap-2">
					<PayloadCard
						label="tool_call"
						name={call.name}
						meta={call.id}
						description={call.description}
						body={call.argumentsText}
					/>
					{call.resultText !== undefined && (
						<PayloadCard label="tool_result" body={call.resultText} />
					)}
				</div>
			))}
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
			{body !== undefined && (
				<div className="border-border/60 border-t bg-background/50 px-2.5 py-2">
					<ClampedText text={body} mono />
				</div>
			)}
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
 */
function DetailsSection({ span }: { span: AiSessionSpan }) {
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

	return (
		<div className="flex flex-col gap-3 pb-1">
			{span.statusCode === "Error" && span.statusMessage !== "" && (
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

function firstLine(text: string): string {
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim()
		if (line !== "") return line
	}
	return ""
}

/**
 * A body that clamps at ~12 lines with a "Show full" control. Overflow is
 * measured, not guessed from length: 12 short lines fit and never grow a
 * control, while one very long line wraps past the clamp and does.
 */
function ClampedText({ text, mono = false }: { text: string; mono?: boolean }) {
	const [expanded, setExpanded] = useState(false)
	const [clamped, setClamped] = useState(false)
	const bodyRef = useRef<HTMLDivElement>(null)

	useLayoutEffect(() => {
		const body = bodyRef.current
		if (body === null || expanded) return
		setClamped(body.scrollHeight > body.clientHeight + 1)
	}, [text, expanded])

	return (
		<div className="min-w-0">
			<div
				ref={bodyRef}
				className={cn(
					"whitespace-pre-wrap break-words",
					mono
						? "font-mono text-muted-foreground text-xs leading-relaxed"
						: "max-w-[70rem] text-foreground text-sm leading-relaxed",
					!expanded && CLAMP_CLASS,
				)}
			>
				{text}
			</div>
			{(clamped || expanded) && (
				<button
					type="button"
					onClick={() => setExpanded((previous) => !previous)}
					className="mt-1 cursor-pointer text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline"
				>
					{expanded ? "Show less" : "Show full"}
				</button>
			)}
		</div>
	)
}
