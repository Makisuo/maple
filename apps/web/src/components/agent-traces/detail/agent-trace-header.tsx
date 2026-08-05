import { useState } from "react"
import { Link } from "@tanstack/react-router"

import { cn } from "@maple/ui/lib/utils"
import { Button } from "@maple/ui/components/ui/button"
import { CopyButton } from "@maple/ui/components/ui/copy-button"
import {
	ChevronDownIcon,
	ChevronRightIcon,
	ExternalLinkIcon,
	ShieldIcon,
	SquareRedactedIcon,
} from "@/components/icons"
import {
	countWords,
	formatClockTime,
	formatCost,
	formatAgentTraceDuration,
	formatTokens,
} from "./agent-trace-format"
import type { AgentTraceModel, AgentTraceSummaryData } from "./agent-trace-model"
import { hasContent } from "./agent-trace-model"
import { AgentTraceBadge } from "./agent-trace-badges"

// ---------------------------------------------------------------------------
// The overview header: identity, the five agent-trace-level stats, and the
// wall-clock band that answers "where did the time go" before anyone scrolls.
// ---------------------------------------------------------------------------

const LABEL = "font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"

export function AgentTraceIdentity({
	agentTraceId,
	summary,
	model,
	traceId,
	windowParam,
}: {
	agentTraceId: string
	summary: AgentTraceSummaryData | null
	model: AgentTraceModel
	traceId: string | null
	windowParam: string | undefined
}) {
	const workflow = summary?.workflowName ?? ""
	const agents = summary?.agents ?? []
	const startedAt = formatClockTime(summary?.startTime)
	const status = summary?.status ?? "ok"

	// A redacted agent trace has no first user message to title itself with, so it
	// falls back through workflow → lead agent → id. It must never render empty.
	const title = summary?.title?.trim() || workflow || agents[0] || agentTraceId

	const trace = traceId != null && traceId.length > 0 ? traceId : null

	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-center gap-2 font-mono text-[11px] leading-none">
				<span className={LABEL}>Agent trace</span>
				{workflow.length > 0 ? (
					<>
						<span className="text-border">·</span>
						<span className={LABEL}>Workflow</span>
						<span className="truncate text-foreground/75">{workflow}</span>
					</>
				) : (
					<>
						<span className="text-border">·</span>
						<span className="truncate text-muted-foreground">{agentTraceId}</span>
						<CopyButton
							value={agentTraceId}
							label="Agent trace ID"
							iconSize={11}
							className="size-4"
							toast={false}
						/>
					</>
				)}
			</div>

			{/* The action rides the heading's own row rather than the block above it,
			    so it centres on the title instead of on whatever the eyebrow and the
			    badge line happen to add up to. */}
			<div className="flex items-center gap-6">
				<h1 className="min-w-0 grow font-display text-[28px] leading-8 font-semibold tracking-tight text-balance text-foreground">
					{title}
				</h1>

				{trace != null && (
					<Button
						size="sm"
						className="shrink-0"
						render={
							<Link
								to="/traces/$traceId"
								params={{ traceId: trace }}
								search={windowParam != null ? { t: windowParam } : {}}
							/>
						}
					>
						Open trace
						<ExternalLinkIcon size={13} />
					</Button>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<AgentTraceStatusPill status={status} />
				{agents.length > 1 && (
					<AgentTraceBadge className="h-[22px] px-2 text-[11px] font-medium">
						{agents.length} agents
					</AgentTraceBadge>
				)}
				<span className="font-mono text-xs text-muted-foreground">
					{[agents[0], summary?.serviceName, startedAt != null ? `started ${startedAt}` : null]
						.filter((part) => part != null && part !== "")
						.join(" · ")}
				</span>
				{model.allContentAbsent && (
					<AgentTraceBadge
						className="h-[22px] px-2 text-[11px] font-medium"
						icon={<SquareRedactedIcon size={10} className="shrink-0 text-muted-foreground" />}
					>
						Content redacted
					</AgentTraceBadge>
				)}
			</div>
		</div>
	)
}

function AgentTraceStatusPill({ status }: { status: "ok" | "error" | "running" }) {
	const tone =
		status === "error"
			? {
					dot: "bg-destructive",
					text: "text-destructive-foreground",
					bg: "bg-destructive/12",
					label: "Failed",
				}
			: status === "running"
				? {
						dot: "bg-warning",
						text: "text-warning-foreground",
						bg: "bg-warning/12",
						label: "Running",
					}
				: {
						dot: "bg-success",
						text: "text-success-foreground",
						bg: "bg-success/12",
						label: "Completed",
					}
	return (
		<span
			className={cn(
				"inline-flex h-[22px] items-center gap-1.5 rounded-sm px-2 font-mono text-[11px] leading-none font-medium",
				tone.bg,
				tone.text,
			)}
		>
			<span
				aria-hidden
				className={cn("size-1.5 rounded-[2px]", tone.dot, status === "running" && "animate-pulse")}
			/>
			{tone.label}
		</span>
	)
}

// ---------------------------------------------------------------------------
// Stat strip
// ---------------------------------------------------------------------------

export function AgentTraceStatStrip({
	summary,
	model,
}: {
	summary: AgentTraceSummaryData | null
	model: AgentTraceModel
}) {
	const models = summary?.models ?? []
	const cost = formatCost(summary?.cost)
	const running = summary?.status === "running"

	return (
		<div className="flex flex-wrap items-start gap-x-6 gap-y-4 px-1">
			<Stat label="Duration" width="w-32">
				<span className="tabular-nums">{formatAgentTraceDuration(summary?.durationMs)}</span>
				{running && <span className="text-muted-foreground"> · now</span>}
			</Stat>

			<StatDivider />
			<Stat label="Models" width="w-56">
				{models.length === 0 ? (
					<span className="text-muted-foreground">unknown</span>
				) : (
					// The multi-model case is the normal case: an agent trace can hop models
					// mid-conversation. Lead with the one that did the most turns and
					// count the rest, rather than truncating a list nobody can read.
					<span className="flex items-center gap-1.5">
						<span className="truncate">{model.models[0]?.name ?? models[0]}</span>
						{models.length > 1 && (
							<AgentTraceBadge title={models.join(", ")}>+{models.length - 1}</AgentTraceBadge>
						)}
					</span>
				)}
			</Stat>

			<StatDivider />
			<Stat label="Tokens" width="w-56">
				<span className="tabular-nums">{formatTokens(summary?.inputTokens ?? 0)}</span>
				<span className="text-muted-foreground"> in · </span>
				<span className="tabular-nums">{formatTokens(summary?.outputTokens ?? 0)}</span>
				<span className="text-muted-foreground"> out</span>
			</Stat>

			{/* Cost is omitted, never zeroed: most emitters send no cost attribute
			    at all, and "$0.00" is a claim the data doesn't support. */}
			{cost != null && (
				<>
					<StatDivider />
					<Stat label="Cost" width="w-28">
						<span className="tabular-nums">{cost}</span>
					</Stat>
				</>
			)}

			<StatDivider />
			<Stat label="Turns">
				{/* `counts.turns` already prefers the summary — going through the model
				    keeps the header, the rail and the timeline chip on one number. */}
				<span className="tabular-nums">{model.counts.turns}</span>
				{(summary?.toolCallCount ?? 0) > 0 && (
					<span className="text-muted-foreground"> · {summary?.toolCallCount} tool calls</span>
				)}
			</Stat>
		</div>
	)
}

function Stat({ label, width, children }: { label: string; width?: string; children: React.ReactNode }) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-2", width)}>
			<span className={LABEL}>{label}</span>
			<span className="truncate font-mono text-[13px] leading-4 text-foreground">{children}</span>
		</div>
	)
}

function StatDivider() {
	return <span aria-hidden className="mt-0.5 hidden h-9 w-px shrink-0 bg-border sm:block" />
}

// ---------------------------------------------------------------------------
// Where the time went
// ---------------------------------------------------------------------------

const CATEGORY_STYLE = {
	model: { swatch: "bg-primary", label: "model" },
	tool: { swatch: "bg-info", label: "tools" },
	failed: { swatch: "bg-severity-error", label: "failed" },
	idle: { swatch: "border border-input", label: "idle" },
} as const

export function AgentTraceTimeBand({ model, running }: { model: AgentTraceModel; running: boolean }) {
	const ticks = buildTicks(model.totalMs)

	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				<span className={LABEL}>Where the time went</span>
				<span className="grow" />
				{(["model", "tool", "failed", "idle"] as const).map((category) => {
					const total = model.timeTotals[category]
					if (total <= 0) return null
					return (
						<span
							key={category}
							className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
						>
							<span
								aria-hidden
								className={cn("size-2 rounded-[2px]", CATEGORY_STYLE[category].swatch)}
							/>
							{CATEGORY_STYLE[category].label} {formatAgentTraceDuration(total)}
						</span>
					)
				})}
			</div>

			{/* Absolutely positioned segments, not flex weights: parallel tool calls
			    overlap in wall-clock time and must render as one stretch, not as
			    consecutive slices that stretch the agent trace past its own duration. */}
			<div className="relative h-6 w-full overflow-hidden rounded-md border border-border bg-muted/40">
				{model.segments.map((segment) => (
					<span
						key={segment.key}
						aria-hidden
						className={cn("absolute inset-y-0", CATEGORY_STYLE[segment.category].swatch)}
						style={{ left: `${segment.startPct}%`, width: `${segment.widthPct}%` }}
					/>
				))}
				{running && (
					<span aria-hidden className="absolute inset-y-0 right-0 w-0.5 animate-pulse bg-primary" />
				)}
			</div>

			<div className="flex items-baseline font-mono text-[11px] text-muted-foreground tabular-nums">
				{/* Keyed by position, not label: a sub-4s agent trace rounds two ticks to
				    the same "1s", and a 1ms one renders five "0s". */}
				{ticks.map((tick, index) => (
					<span key={index} className={cn(index === ticks.length - 1 ? "shrink-0" : "grow")}>
						{tick.label}
					</span>
				))}
			</div>
		</div>
	)
}

function buildTicks(totalMs: number): Array<{ label: string }> {
	const quarter = totalMs / 4
	return [
		{ label: "0s" },
		{ label: formatAgentTraceDuration(quarter) },
		{ label: formatAgentTraceDuration(quarter * 2) },
		{ label: formatAgentTraceDuration(quarter * 3) },
		{ label: formatAgentTraceDuration(totalMs) },
	]
}

// ---------------------------------------------------------------------------
// Privacy banner + system prompt
// ---------------------------------------------------------------------------

export function AgentTracePrivacyBanner({ contentInEvents }: { contentInEvents: boolean }) {
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/40 px-3.5 py-2.5">
			<ShieldIcon size={13} className="shrink-0 text-muted-foreground" />
			<span className={LABEL}>Privacy mode</span>
			<span aria-hidden className="hidden h-3.5 w-px bg-border sm:block" />
			<span className="font-mono text-xs text-muted-foreground">
				{contentInEvents
					? "Message text was recorded as span events, which this view does not read yet. Timing, tokens, models and cost are complete."
					: "This provider does not record message text. Timing, tokens, models and cost are complete."}
			</span>
		</div>
	)
}

/**
 * Pinned above the conversation, collapsed by default. It is reference
 * material, not dialogue — hence the panel treatment rather than a message
 * block, and a length hint on the collapsed state, because the only thing you
 * can know about an unread 11,000-token prompt is how much of it there is.
 */
export function AgentTraceSystemPrompt({
	event,
	promptTokens,
}: {
	event: AgentTraceModel["systemPrompt"]
	promptTokens: number | null
}) {
	const [open, setOpen] = useState(false)
	if (event == null) return null

	const content = hasContent(event) ? event.content : null
	const words = content != null ? countWords(content) : null
	const tokens = promptTokens ?? event.inputTokens

	return (
		<div className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/40 px-4 py-3.5">
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				className="flex items-center gap-2.5 text-left"
				disabled={content == null}
			>
				{content != null &&
					(open ? (
						<ChevronDownIcon size={9} className="shrink-0 text-muted-foreground" />
					) : (
						<ChevronRightIcon size={9} className="shrink-0 text-muted-foreground" />
					))}
				<span className={LABEL}>System prompt</span>
				<span className="grow" />
				<span className="font-mono text-[11px] text-muted-foreground tabular-nums">
					{[
						words != null ? `${words.toLocaleString()} words` : null,
						tokens != null && tokens > 0 ? `${tokens.toLocaleString()} tokens` : null,
					]
						.filter((part) => part != null)
						.join(" · ")}
				</span>
			</button>

			{content == null ? (
				<div className="flex items-center gap-2 text-muted-foreground">
					<SquareRedactedIcon size={11} className="shrink-0 text-input" />
					<span className="font-mono text-xs">content not recorded · length is still known</span>
				</div>
			) : (
				<p
					className={cn(
						"font-mono text-xs leading-[19px] whitespace-pre-wrap text-muted-foreground",
						!open && "line-clamp-3",
					)}
				>
					{content}
				</p>
			)}
		</div>
	)
}
