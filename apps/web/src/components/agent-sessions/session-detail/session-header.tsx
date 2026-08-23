import type { ReactNode } from "react"

import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"

import { formatCurrency } from "@/lib/billing/currency"
import type { SessionSummary } from "@/lib/agent-sessions/session-summary"
import { shortTarget } from "@/lib/agent-sessions/span-filters"
import { OCCUPANCY_DOT_FILL, OCCUPANCY_FILL, OCCUPANCY_LABEL } from "./span-visuals"

const TOKEN_BUCKETS = [
	{ key: "input", label: "input", fill: "bg-chart-2" },
	{ key: "cacheRead", label: "cache read", fill: "bg-chart-4" },
	{ key: "cacheWrite", label: "cache write", fill: "bg-chart-5" },
	{ key: "output", label: "output", fill: "bg-chart-1" },
	{ key: "reasoning", label: "reasoning", fill: "bg-chart-3" },
] as const

/** Enough rows to show the mix without turning the column into a list. What
 *  the slice drops is counted underneath rather than vanishing. */
const MODEL_ROW_LIMIT = 4

const ROW_TONE = {
	warn: "text-severity-warn",
	error: "text-destructive",
} as const

interface SessionHeaderProps {
	summary: SessionSummary
}

export function SessionHeader({ summary }: SessionHeaderProps) {
	// Everything here is a share of the wall clock — the bar, the legend and the
	// active/idle line all read against the one duration in the headline.
	const segments = summary.occupancy
		.map((segment) => ({ ...segment, percent: sharePercent(segment.ms, summary.wallClockMs) }))
		// Under half a percent the segment is a sub-pixel sliver against a legend
		// row that reads "0%" — the muted track behind the bar covers the loss.
		.filter((segment) => segment.percent >= 0.5)
	const hasTokens = summary.tokens.total > 0
	const tokenBuckets = TOKEN_BUCKETS.filter((bucket) => summary.tokens[bucket.key] > 0)

	return (
		<section className="@container">
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<span className="whitespace-nowrap font-mono font-semibold text-lg tabular-nums tracking-tight">
					{formatSessionDuration(summary.wallClockMs)}
				</span>
				<span className="text-muted-foreground text-xs">wall clock</span>
				{summary.idleMs > 0 && (
					<span className="whitespace-nowrap text-muted-foreground text-xs tabular-nums">
						{formatSessionDuration(summary.activeMs)} active ·{" "}
						{formatPercent(sharePercent(summary.idleMs, summary.wallClockMs) / 100)} idle
					</span>
				)}
			</div>

			<div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
				{segments.map((segment) => (
					<div
						key={segment.kind}
						className={OCCUPANCY_FILL[segment.kind]}
						style={{ width: `${segment.percent}%` }}
					/>
				))}
			</div>
			<div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 text-xs">
				{segments.map((segment) => (
					<span key={segment.kind} className="flex items-center gap-1.5">
						<span
							aria-hidden
							className={cn("size-1.5 rounded-full", OCCUPANCY_DOT_FILL[segment.kind])}
						/>
						<span>{OCCUPANCY_LABEL[segment.kind]}</span>
						<span className="text-muted-foreground tabular-nums">
							{formatPercent(segment.percent / 100)}
						</span>
					</span>
				))}
			</div>
			{/* No 4-col step: five stats still wrap to two rows at four columns. */}
			<div className="mt-6 flex flex-col divide-y divide-border border-border border-t @2xl:grid @2xl:grid-cols-2 @2xl:divide-x @3xl:grid-cols-3 @4xl:grid-cols-5 @4xl:divide-y-0">
				<StatColumn title="Models & agents">
					{summary.models.length === 0 ? (
						<EmptyStat>no model calls</EmptyStat>
					) : (
						<div className="max-w-sm space-y-1">
							{summary.models.slice(0, MODEL_ROW_LIMIT).map((model) => (
								<div key={model.model} className="flex items-center gap-2 text-xs">
									{/* Gateways prefix the provider path, and two models from one
									    gateway truncate to the same string in this column. */}
									<span className="min-w-0 flex-1 truncate" title={model.model}>
										{shortTarget(model.model)}
									</span>
									<span className="w-8 text-right tabular-nums">{model.llmCalls}</span>
								</div>
							))}
							{summary.models.length > MODEL_ROW_LIMIT && (
								<p className="text-muted-foreground text-xs">
									+{summary.models.length - MODEL_ROW_LIMIT} more
								</p>
							)}
						</div>
					)}
					{summary.agentNames.length > 0 && (
						<p
							className="mt-2 truncate text-muted-foreground text-xs"
							title={summary.agentNames.join(" → ")}
						>
							<span className="text-foreground">
								{summary.agentNames.length} agent{summary.agentNames.length === 1 ? "" : "s"}
							</span>{" "}
							{summary.agentNames.join(" → ")}
						</p>
					)}
				</StatColumn>

				{/* Usage capture is opt-in per framework, so "no tokens" is a real and
				    common state — and 0 / $0.00 reads as a measurement rather than the
				    absence of one. */}
				<StatColumn title="Tokens">
					{!hasTokens ? (
						<EmptyStat>no token usage reported</EmptyStat>
					) : (
						<>
							<p className="mb-2 font-mono font-semibold text-sm tabular-nums">
								{formatNumber(summary.tokens.total)}
							</p>
							<div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
								{tokenBuckets.map((bucket) => (
									<div
										key={bucket.key}
										className={bucket.fill}
										style={{
											width: `${sharePercent(summary.tokens[bucket.key], summary.tokens.total)}%`,
										}}
									/>
								))}
							</div>
							<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
								{tokenBuckets.map((bucket) => (
									<span key={bucket.key} className="flex items-center gap-1.5">
										<span
											aria-hidden
											className={cn("size-1.5 rounded-full", bucket.fill)}
										/>
										<span className="text-muted-foreground">{bucket.label}</span>
										<span className="tabular-nums">
											{formatNumber(summary.tokens[bucket.key])}
										</span>
									</span>
								))}
							</div>
							{/* The one reporting shape the reader has to be told about: the
							    turns below cannot show a share of this, so an unexplained
							    column of dashes would read as missing instrumentation. */}
							{summary.tokenReporting === "session-level" && (
								<p className="mt-2 text-muted-foreground text-xs">
									Reported once for the whole session
								</p>
							)}
						</>
					)}
				</StatColumn>

				<StatColumn title="Cost">
					{summary.cost === undefined ? (
						<EmptyStat>no cost reported</EmptyStat>
					) : (
						<>
							{/* A $0.0004 session printed "$0.00" beside a real token count,
							    which reads as "measured, and it was free" rather than "too
							    small to show". */}
							<p className="font-mono font-semibold text-2xl text-primary tabular-nums">
								{summary.cost > 0 && summary.cost < 0.01
									? "<$0.01"
									: formatCurrency(summary.cost, "usd")}
							</p>
							<p className="mt-1 text-muted-foreground text-xs">
								As reported by the instrumentation
							</p>
						</>
					)}
				</StatColumn>

				<StatColumn title="Work">
					<StatRow label="turns" value={summary.work.turns} />
					<StatRow label="LLM calls" value={summary.work.llmCalls} />
					<StatRow label="tool calls" value={summary.work.toolCalls} />
				</StatColumn>

				<StatColumn title="Failures">
					<StatRow label="errors" value={summary.failures.errors} tone="error" />
					<StatRow label="rate limited" value={summary.failures.rateLimited} tone="error" />
					<StatRow label="context exceeded" value={summary.failures.contextExceeded} tone="error" />
					<StatRow label="refusals" value={summary.failures.refusals} tone="error" />
				</StatColumn>
			</div>
		</section>
	)
}

function sharePercent(value: number, total: number): number {
	if (total <= 0) return 0
	return (value / total) * 100
}

function StatColumn({ title, children }: { title: string; children: ReactNode }) {
	// `first:pl-0 last:pr-0` flushes the band with the heading above it, which
	// only holds once the five columns are one row — in the two- and three-column
	// grids "first" is one cell of several in the left column, so every cell there
	// keeps its padding.
	return (
		<div className="py-3.5 @2xl:px-4 @2xl:py-3 @4xl:first:pl-0 @4xl:last:pr-0">
			<p className="mb-2 font-medium text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
				{title}
			</p>
			{children}
		</div>
	)
}

function StatRow({ label, value, tone }: { label: string; value: number; tone?: keyof typeof ROW_TONE }) {
	return (
		// Capped: in the stacked and two-column layouts the column is most of the
		// page, and a label at one edge with its number at the other is two facts,
		// not one.
		<div className="flex max-w-sm items-baseline justify-between gap-3 text-xs leading-6">
			<span className="text-muted-foreground">{label}</span>
			<span
				className={cn(
					"tabular-nums",
					tone !== undefined && (value === 0 ? "text-muted-foreground" : ROW_TONE[tone]),
				)}
			>
				{value}
			</span>
		</div>
	)
}

function EmptyStat({ children }: { children: ReactNode }) {
	return <p className="text-muted-foreground text-xs">{children}</p>
}
