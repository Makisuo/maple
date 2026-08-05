import { useMemo, useState } from "react"

import { cn } from "@maple/ui/lib/utils"
import { ChevronDownIcon, ChevronRightIcon, XmarkIcon } from "@/components/icons"
import {
	formatJsonPayload,
	formatTurnDuration,
	parseWarehouseTimestamp,
	summariseToolArguments,
} from "./agent-trace-format"
import type { AgentTraceEventData } from "./agent-trace-model"

// ---------------------------------------------------------------------------
// The tool table archetype.
//
// Two things the design brief insists on, and both are geometry:
//
// - **Parallel calls must read as parallel.** The bars share one time axis
//   scoped to the block, so three calls fired together start at the same x.
//   Sequential calls (a retry after a failure) start where the previous one
//   ended. The left rule groups overlapping calls into one bunch.
// - **Failures are obvious without expanding.** The status mark, the summary
//   cell, the bar and the duration all turn red — the row reads as failed at
//   any scan distance, not just where the eye lands.
// ---------------------------------------------------------------------------

interface ToolLane {
	readonly call: AgentTraceEventData
	readonly startMs: number
	readonly durationMs: number
	readonly startPct: number
	readonly widthPct: number
	/** Index of the overlapping bunch this call belongs to. */
	readonly bunch: number
}

export function AgentTraceToolCalls({ calls }: { calls: ReadonlyArray<AgentTraceEventData> }) {
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

	const { lanes, windowMs, parallelCount, failedCount } = useMemo(() => buildLanes(calls), [calls])
	if (lanes.length === 0) return null

	const toggle = (id: string) =>
		setExpanded((current) => {
			const next = new Set(current)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})

	return (
		<div className="mt-1 flex flex-col overflow-hidden rounded-lg border border-border bg-muted/30">
			<div className="flex items-end gap-3 border-b border-border px-4 pt-2.5 pb-2">
				<div className="flex min-w-0 grow flex-wrap items-baseline gap-2 font-mono text-[11px] text-muted-foreground">
					<span className="font-medium tracking-[0.08em] uppercase">
						{lanes.length} tool call{lanes.length === 1 ? "" : "s"}
					</span>
					{parallelCount > 1 && (
						<>
							<span className="text-border">·</span>
							<span>{parallelCount} in parallel</span>
						</>
					)}
					{failedCount > 0 && (
						<>
							<span className="text-border">·</span>
							<span className="text-destructive-foreground">{failedCount} failed</span>
						</>
					)}
				</div>
				<div className="hidden w-[300px] shrink-0 flex-col gap-1 lg:flex">
					<div className="flex items-baseline font-mono text-[11px] text-muted-foreground tabular-nums">
						<span className="grow">0s</span>
						<span className="grow">{formatTurnDuration(windowMs / 2)}</span>
						<span className="text-right">{formatTurnDuration(windowMs)}</span>
					</div>
					<div aria-hidden className="flex h-1 items-start">
						<span className="h-1 grow border-l border-input" />
						<span className="h-1 grow border-l border-input" />
						<span className="h-1 w-px shrink-0 bg-input" />
					</div>
				</div>
				<div className="hidden w-[62px] shrink-0 lg:block" />
			</div>

			<div className="flex flex-col px-4 pt-1 pb-2">
				{lanes.map((lane, index) => {
					const previous = lanes[index - 1]
					const startsBunch = previous == null || previous.bunch !== lane.bunch
					const bunchSize = lanes.filter((other) => other.bunch === lane.bunch).length
					return (
						<div
							key={lane.call.id}
							className={cn(
								"flex flex-col pl-2",
								bunchSize > 1 ? "border-l border-input" : "border-l border-transparent",
								startsBunch && index > 0 && "mt-0.5",
							)}
						>
							<ToolRow
								lane={lane}
								expanded={expanded.has(lane.call.id)}
								onToggle={() => toggle(lane.call.id)}
								isLast={index === lanes.length - 1}
							/>
						</div>
					)
				})}
			</div>
		</div>
	)
}

function ToolRow({
	lane,
	expanded,
	onToggle,
	isLast,
}: {
	lane: ToolLane
	expanded: boolean
	onToggle: () => void
	isLast: boolean
}) {
	const { call } = lane
	const failed = call.status === "error"
	const summary = failed
		? [call.statusMessage, call.toolResult].find((value) => value != null && value.length > 0) ||
			"tool call failed"
		: (summariseToolArguments(call.toolArguments) ?? "arguments not recorded")

	return (
		<div className={cn("flex flex-col", !isLast && "border-b border-border/70")}>
			<button
				type="button"
				onClick={onToggle}
				aria-expanded={expanded}
				className="flex w-full items-center gap-2 py-1.5 text-left hover:bg-foreground/[0.03]"
			>
				<span className="flex w-3 shrink-0 justify-center">
					{failed ? (
						<XmarkIcon size={9} className="text-severity-error" />
					) : (
						<span aria-hidden className="size-1.5 rounded-[2px] bg-info" />
					)}
				</span>
				<span className="flex w-2.5 shrink-0 justify-center text-muted-foreground">
					{expanded ? <ChevronDownIcon size={8} /> : <ChevronRightIcon size={8} />}
				</span>
				<span className="w-40 shrink-0 truncate font-mono text-[13px] text-foreground xl:w-52">
					{call.toolName ?? call.spanName ?? "tool"}
				</span>
				<span
					className={cn(
						"min-w-0 grow truncate font-mono text-xs",
						failed ? "text-destructive-foreground" : "text-muted-foreground",
					)}
				>
					{summary}
				</span>
				<span aria-hidden className="hidden w-[300px] shrink-0 items-center lg:flex">
					<span className="relative h-1.5 w-full">
						<span
							className={cn(
								"absolute inset-y-0 rounded-[2px]",
								failed ? "bg-severity-error" : "bg-info",
							)}
							style={{ left: `${lane.startPct}%`, width: `${lane.widthPct}%` }}
						/>
					</span>
				</span>
				<span
					className={cn(
						"w-[62px] shrink-0 text-right font-mono text-xs tabular-nums",
						failed ? "text-destructive-foreground" : "text-foreground/75",
					)}
				>
					{formatTurnDuration(lane.durationMs)}
				</span>
			</button>

			{expanded && (
				<div className="flex flex-col gap-2 pb-2.5 pl-[26px]">
					<PayloadBlock label="Arguments" value={call.toolArguments} />
					<PayloadBlock
						label={failed ? "Error" : "Result"}
						value={call.toolResult}
						tone={failed ? "error" : "default"}
					/>
					{failed && call.statusMessage != null && call.toolResult == null && (
						<PayloadBlock label="Error" value={call.statusMessage} tone="error" />
					)}
				</div>
			)}
		</div>
	)
}

function PayloadBlock({
	label,
	value,
	tone = "default",
}: {
	label: string
	value: string | null
	tone?: "default" | "error"
}) {
	return (
		<div className="flex flex-col gap-1">
			<span className="font-mono text-[11px] font-medium tracking-[0.08em] uppercase text-muted-foreground">
				{label}
			</span>
			{value == null || value.length === 0 ? (
				<span className="font-mono text-xs text-muted-foreground/80">not recorded</span>
			) : (
				<pre
					className={cn(
						"max-h-72 overflow-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-[17px] whitespace-pre-wrap",
						tone === "error" ? "text-destructive-foreground" : "text-foreground/85",
					)}
				>
					{formatJsonPayload(value)}
				</pre>
			)}
		</div>
	)
}

// ---------------------------------------------------------------------------

function buildLanes(calls: ReadonlyArray<AgentTraceEventData>): {
	lanes: ReadonlyArray<ToolLane>
	windowMs: number
	parallelCount: number
	failedCount: number
} {
	const timed = calls
		.map((call) => ({
			call,
			startMs: parseWarehouseTimestamp(call.timestamp) ?? 0,
			durationMs: Math.max(0, call.durationMs ?? 0),
		}))
		.sort((a, b) => a.startMs - b.startMs || a.call.id.localeCompare(b.call.id))

	if (timed.length === 0) {
		return { lanes: [], windowMs: 1, parallelCount: 0, failedCount: 0 }
	}

	const windowStart = timed[0].startMs
	const windowEnd = timed.reduce(
		(max, entry) => Math.max(max, entry.startMs + entry.durationMs),
		windowStart,
	)
	const windowMs = Math.max(1, windowEnd - windowStart)

	// Bunch = a maximal run of calls that overlap in time. The bunch a call
	// lands in is what draws the parallel rule; it is also what "N in parallel"
	// counts, so the header can't disagree with the bars.
	let bunch = 0
	let bunchEnd = -Infinity
	const lanes = timed.map((entry) => {
		if (entry.startMs >= bunchEnd) {
			bunch += 1
			bunchEnd = entry.startMs + entry.durationMs
		} else {
			bunchEnd = Math.max(bunchEnd, entry.startMs + entry.durationMs)
		}
		return {
			call: entry.call,
			startMs: entry.startMs,
			durationMs: entry.durationMs,
			startPct: ((entry.startMs - windowStart) / windowMs) * 100,
			widthPct: Math.max(1.5, (entry.durationMs / windowMs) * 100),
			bunch,
		}
	})

	const bunchSizes = new Map<number, number>()
	for (const lane of lanes) bunchSizes.set(lane.bunch, (bunchSizes.get(lane.bunch) ?? 0) + 1)

	return {
		lanes,
		windowMs,
		parallelCount: Math.max(0, ...bunchSizes.values()),
		failedCount: lanes.filter((lane) => lane.call.status === "error").length,
	}
}
