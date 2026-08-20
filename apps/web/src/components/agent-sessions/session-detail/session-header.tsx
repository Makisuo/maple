import { useMemo, useState, type ReactNode } from "react"

import { Badge } from "@maple/ui/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import { formatNumber, formatPercent } from "@maple/ui/lib/format"
import { formatSessionDuration } from "@maple/ui/lib/replay-format"
import { cn } from "@maple/ui/lib/utils"

import { computeModelSpend, PRICE_TABLE_DATE } from "@/lib/agent-sessions/model-pricing"
import type { SessionStatus, SessionSummary } from "@/lib/agent-sessions/session-summary"
import { vendorLabel } from "@/components/agent-sessions/agent-sessions-list"
import { OCCUPANCY_FILL, OCCUPANCY_LABEL } from "./span-visuals"

/**
 * Which clock the header measures against.
 *
 * A session that waited eleven minutes on a human is two different sessions
 * depending on which clock you read it by, and neither is the right default for
 * everyone — so both are one click apart. This governs the header alone: the
 * waterfall's axis has its own control ("Collapse idle") sitting next to it,
 * because dropping idle from a ruler and dropping it from a percentage are
 * different decisions and a reader may well want one without the other.
 */
export type AxisMode = "wall" | "active"

const STATUS_LABEL = {
	active: "ACTIVE",
	completed: "COMPLETED",
	failed: "FAILED",
	abandoned: "ABANDONED",
} satisfies Record<SessionStatus, string>

const STATUS_VARIANT = {
	active: "info",
	completed: "success",
	failed: "error",
	abandoned: "outline",
} as const

const TOKEN_BUCKETS = [
	{ key: "input", label: "input", fill: "bg-chart-2" },
	{ key: "cacheRead", label: "cache read", fill: "bg-chart-4" },
	{ key: "cacheWrite", label: "cache write", fill: "bg-chart-5" },
	{ key: "output", label: "output", fill: "bg-chart-1" },
	{ key: "reasoning", label: "reasoning", fill: "bg-chart-3" },
] as const

interface SessionHeaderProps {
	summary: SessionSummary
	/** The framework's own session id, verbatim. */
	sessionId: string
	/** Rendered when the session captured no opening user message. */
	fallbackTitle: string
}

export function SessionHeader({ summary, sessionId, fallbackTitle }: SessionHeaderProps) {
	const [axisMode, setAxisMode] = useState<AxisMode>("wall")
	const spend = useMemo(() => computeModelSpend(summary.models), [summary.models])

	// In "active only" the idle segment leaves the bar entirely and the rest are
	// re-based on active time — otherwise every share on a session with a long
	// pause reads as single digits and the bar says nothing.
	const denominatorMs = axisMode === "wall" ? summary.wallClockMs : summary.activeMs
	const segments = summary.occupancy.filter(
		(segment) => axisMode === "wall" || segment.kind !== "idle",
	)

	return (
		<section className="@container">
			<div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
				<h1 className="min-w-0 flex-1 truncate font-semibold text-xl tracking-tight @2xl:text-2xl">
					{summary.title ?? fallbackTitle}
				</h1>
				<Badge variant={STATUS_VARIANT[summary.status]} className="mt-1 tracking-wide">
					{STATUS_LABEL[summary.status]}
				</Badge>
			</div>

			<div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
				<ChipGroup values={summary.vendorIds.map(vendorLabel)} emptyLabel="unknown framework" />
				{summary.serviceNames.length > 0 && <span className="text-border">|</span>}
				<ChipGroup values={summary.serviceNames} emptyLabel="" />
				{/* The breadcrumb above carries a truncated id; the full one is here,
				    small, because it is what a support thread asks for. */}
				<span className="text-border">|</span>
				<span className="truncate font-mono text-[11px]">{sessionId}</span>
			</div>

			<div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-2">
				<span className="whitespace-nowrap font-semibold text-3xl tabular-nums">
					{formatSessionDuration(axisMode === "wall" ? summary.wallClockMs : summary.activeMs)}
				</span>
				<span className="text-muted-foreground text-xs">
					{axisMode === "wall" ? "wall clock" : "active only"}
				</span>
				<span aria-hidden className="h-4 w-px self-center bg-border" />
				<span className="whitespace-nowrap font-semibold text-sm tabular-nums">
					{formatSessionDuration(axisMode === "wall" ? summary.activeMs : summary.idleMs)}
				</span>
				<span className="text-muted-foreground text-xs">
					{axisMode === "wall" ? "active" : "idle"} ·{" "}
					{formatPercent(
						summary.wallClockMs === 0
							? 0
							: (axisMode === "wall" ? summary.activeMs : summary.idleMs) / summary.wallClockMs,
					)}
				</span>
				<ToggleGroup
					className="ml-auto"
					size="sm"
					variant="outline"
					value={[axisMode]}
					onValueChange={(values) => {
						const next = values[0]
						if (next === "wall" || next === "active") setAxisMode(next)
					}}
					aria-label="Time axis"
				>
					<ToggleGroupItem value="wall">Wall clock</ToggleGroupItem>
					<ToggleGroupItem value="active">Active only</ToggleGroupItem>
				</ToggleGroup>
			</div>

			<div className="mt-3">
				<div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
					{segments.map((segment) => (
						<div
							key={segment.kind}
							className={OCCUPANCY_FILL[segment.kind]}
							style={{ width: `${sharePercent(segment.ms, denominatorMs)}%` }}
						/>
					))}
				</div>
				<div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
					{segments.map((segment) => (
						<span key={segment.kind} className="flex items-center gap-1.5">
							<span
								aria-hidden
								className={cn("size-1.5 rounded-full", OCCUPANCY_FILL[segment.kind])}
							/>
							<span className="text-muted-foreground">{OCCUPANCY_LABEL[segment.kind]}</span>
							<span className="tabular-nums">{formatSessionDuration(segment.ms)}</span>
							<span className="text-muted-foreground tabular-nums">
								{formatPercent(denominatorMs === 0 ? 0 : segment.ms / denominatorMs)}
							</span>
						</span>
					))}
				</div>
			</div>

			<div className="mt-4 flex flex-col divide-y divide-border border-border border-t @5xl:grid @5xl:grid-cols-5 @5xl:divide-x @5xl:divide-y-0">
				<StatColumn title="Models & agents">
					{summary.models.length === 0 ? (
						<EmptyStat>no model calls</EmptyStat>
					) : (
						<div className="space-y-1">
							{summary.models.slice(0, 4).map((model) => (
								<div key={model.model} className="flex items-center gap-2 text-xs">
									<span className="min-w-0 flex-1 truncate" title={model.model}>
										{model.model}
									</span>
									<span className="hidden h-1 w-14 overflow-hidden rounded-full bg-muted @5xl:block">
										<span
											className="block h-full rounded-full bg-chart-2"
											style={{
												width: `${sharePercent(model.llmCalls, summary.models[0]!.llmCalls)}%`,
											}}
										/>
									</span>
									<span className="w-8 text-right tabular-nums">{model.llmCalls}</span>
								</div>
							))}
						</div>
					)}
					{summary.agentNames.length > 0 && (
						<p className="mt-2 truncate text-muted-foreground text-xs">
							<span className="text-foreground">
								{summary.agentNames.length} agent{summary.agentNames.length === 1 ? "" : "s"}
							</span>{" "}
							{summary.agentNames.join(" → ")}
						</p>
					)}
				</StatColumn>

				<StatColumn title="Tokens" value={formatNumber(summary.tokens.total)}>
					<div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
						{TOKEN_BUCKETS.map((bucket) => (
							<div
								key={bucket.key}
								className={bucket.fill}
								style={{ width: `${sharePercent(summary.tokens[bucket.key], summary.tokens.total)}%` }}
							/>
						))}
					</div>
					<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
						{TOKEN_BUCKETS.map((bucket) => (
							<span key={bucket.key} className="flex items-center gap-1.5">
								<span aria-hidden className={cn("size-1.5 rounded-full", bucket.fill)} />
								<span className="text-muted-foreground">{bucket.label}</span>
								<span className="tabular-nums">{formatNumber(summary.tokens[bucket.key])}</span>
							</span>
						))}
					</div>
				</StatColumn>

				<StatColumn title="Model spend">
					<div className="flex items-baseline gap-1.5">
						<span className="font-semibold text-2xl text-primary tabular-nums">
							${spend.totalUsd.toFixed(2)}
						</span>
						<span className="text-muted-foreground text-xs">est.</span>
					</div>
					<p className="mt-1 text-muted-foreground text-xs">list price · {PRICE_TABLE_DATE}</p>
					{spend.unpricedModels.length > 0 && (
						<p className="mt-0.5 text-primary text-xs" title={spend.unpricedModels.join(", ")}>
							{spend.unpricedModels.length} model
							{spend.unpricedModels.length === 1 ? "" : "s"} unpriced
						</p>
					)}
				</StatColumn>

				<StatColumn title="Work">
					<StatRow label="turns" value={summary.work.turns} />
					<StatRow label="llm calls" value={summary.work.llmCalls} />
					<StatRow label="tool calls" value={summary.work.toolCalls} />
					<StatRow label="retries" value={summary.work.retries} tone="warn" />
				</StatColumn>

				<StatColumn title="Failures" danger>
					<StatRow label="tool errors" value={summary.failures.toolErrors} tone="error" />
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
	return Math.max(0, Math.min(100, (value / total) * 100))
}

/** First value in full, the rest as a count — a session routinely touches four
 *  services, and naming one as if it were the whole session would be a lie. */
function ChipGroup({ values, emptyLabel }: { values: readonly string[]; emptyLabel: string }) {
	if (values.length === 0) return emptyLabel === "" ? null : <span>{emptyLabel}</span>
	return (
		<span className="flex items-center gap-1.5">
			<span className="truncate text-foreground">{values[0]}</span>
			{values.length > 1 && (
				<span
					className="rounded-sm bg-muted px-1 py-px text-[10px] tabular-nums"
					title={values.slice(1).join(", ")}
				>
					+{values.length - 1}
				</span>
			)}
		</span>
	)
}

function StatColumn({
	title,
	value,
	danger,
	children,
}: {
	title: string
	value?: string
	danger?: boolean
	children: ReactNode
}) {
	return (
		<div className="py-3.5 @5xl:px-4 @5xl:py-3 @5xl:first:pl-0 @5xl:last:pr-0">
			<p className="mb-2 flex items-baseline gap-2">
				<span
					className={cn(
						"font-medium text-[11px] uppercase tracking-wider",
						danger ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{title}
				</span>
				{value !== undefined && <span className="font-medium text-sm tabular-nums">{value}</span>}
			</p>
			{children}
		</div>
	)
}

function StatRow({
	label,
	value,
	tone,
}: {
	label: string
	value: number
	tone?: "warn" | "error"
}) {
	return (
		<div className="flex items-baseline justify-between gap-3 text-xs leading-6">
			<span className="text-muted-foreground">{label}</span>
			<span
				className={cn(
					"tabular-nums",
					value === 0 && tone !== undefined && "text-muted-foreground",
					value > 0 && tone === "warn" && "text-primary",
					value > 0 && tone === "error" && "text-destructive",
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
