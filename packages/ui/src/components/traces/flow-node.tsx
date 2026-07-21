import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import { DatabaseIcon } from "../icons"

import { cn } from "../../lib/utils"
import { formatDuration } from "../../lib/format"
import { cacheResultStyles } from "../../lib/cache"
import type { CacheInfo } from "../../lib/cache"
import { describeSpan } from "../../lib/span-category"
import type { SpanDescription } from "../../lib/span-category"
import { outcomeBadgeStyle, pickAttr } from "../../lib/cloud-platforms"
import { ServiceDot } from "../service-dot"
import type { FlowNodeData, AggregatedDuration } from "./flow-utils"

/**
 * Format duration display for combined spans
 * Shows "avg (min - max)" format for combined, simple duration for single
 */
function formatCombinedDuration(
	isCombined: boolean,
	singleDuration: number,
	aggregatedDuration: AggregatedDuration,
): { main: string; tooltip: string } {
	if (!isCombined) {
		const formatted = formatDuration(singleDuration)
		return { main: formatted, tooltip: formatted }
	}

	const avg = formatDuration(aggregatedDuration.avg)
	const min = formatDuration(aggregatedDuration.min)
	const max = formatDuration(aggregatedDuration.max)
	const total = formatDuration(aggregatedDuration.total)

	return {
		main: `avg ${avg}`,
		tooltip: `Avg: ${avg} | Min: ${min} | Max: ${max} | Total: ${total}`,
	}
}

function CacheSystemIcon({ system, size = 12 }: { system: CacheInfo["system"]; size?: number }) {
	const name = system?.toLowerCase()

	if (name === "redis") {
		return (
			<svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="shrink-0">
				<path
					d="M22.5 13.7c-.1.5-1.6 1.2-4.6 2.3-1.7.7-3.8 1.3-5.9 1.7-2.1-.4-4.2-1-5.9-1.7C3.1 14.9 1.6 14.2 1.5 13.7v2.5c0 .6 1.5 1.3 4.5 2.3 1.7.7 3.8 1.3 5.9 1.7 2.1-.4 4.2-1 5.9-1.7 3-1 4.6-1.7 4.6-2.3V13.7z"
					fill="currentColor"
					opacity="0.4"
				/>
				<path
					d="M22.5 9.2c-.1.5-1.6 1.2-4.6 2.3-1.7.7-3.8 1.3-5.9 1.7-2.1-.4-4.2-1-5.9-1.7C3.1 10.4 1.6 9.7 1.5 9.2v2.5c0 .6 1.5 1.3 4.5 2.3 1.7.7 3.8 1.3 5.9 1.7 2.1-.4 4.2-1 5.9-1.7 3-1 4.6-1.7 4.6-2.3V9.2z"
					fill="currentColor"
					opacity="0.6"
				/>
				<path
					d="M22.5 4.7c0 .6-1.5 1.3-4.6 2.3C16.2 7.7 14.1 8.3 12 8.7 9.9 8.3 7.8 7.7 6.1 7 3.1 6 1.5 5.3 1.5 4.7S3.1 3.4 6.1 2.4C7.8 1.7 9.9 1.1 12 .7c2.1.4 4.2 1 5.9 1.7 3 1 4.6 1.7 4.6 2.3z"
					fill="currentColor"
					opacity="0.9"
				/>
			</svg>
		)
	}

	return <DatabaseIcon size={size} className="shrink-0 text-current" />
}

/** The most specific single-line description of what the span did. */
function getPrimaryText(
	span: { spanName: string; spanAttributes: Record<string, string> },
	desc: SpanDescription,
): string {
	const { httpInfo, cacheInfo, category } = desc
	if (category.id === "cache" && cacheInfo) {
		const op = cacheInfo.operation?.toUpperCase()
		const name = cacheInfo.name ?? span.spanName
		return op ? `${op} ${name}` : name
	}
	if ((category.id === "http" || category.id === "server") && httpInfo) {
		return `${httpInfo.method} ${httpInfo.route ?? span.spanName}`
	}
	if (category.id === "db") {
		const operation = pickAttr(span.spanAttributes, "db.operation.name", "db.operation")
		const table = pickAttr(span.spanAttributes, "db.collection.name")
		if (operation) return table ? `${operation} ${table}` : operation
	}
	return span.spanName
}

function StatusBadge({
	desc,
	isError,
	statusCode,
}: {
	desc: SpanDescription
	isError: boolean
	statusCode: string
}) {
	const { platform, cacheInfo, httpInfo } = desc
	const base = "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold"

	if (platform?.outcome?.bad) {
		return (
			<span className={cn(base, outcomeBadgeStyle(true))} title={`${platform.label} outcome`}>
				{platform.outcome.value}
			</span>
		)
	}
	if (cacheInfo?.result) {
		return (
			<span className={cn(base, "font-mono", cacheResultStyles[cacheInfo.result])}>
				{cacheInfo.result === "hit" ? "HIT" : "MISS"}
			</span>
		)
	}
	if (httpInfo?.statusCode != null) {
		const code = httpInfo.statusCode
		return (
			<span
				className={cn(
					base,
					"font-mono",
					code >= 200 && code < 300 && "bg-severity-info/15 text-severity-info",
					code >= 300 && code < 400 && "bg-chart-p50/15 text-chart-p50",
					code >= 400 && code < 500 && "bg-severity-warn/15 text-severity-warn",
					code >= 500 && "bg-severity-error/15 text-severity-error",
					code < 200 && "text-muted-foreground",
				)}
			>
				{code}
			</span>
		)
	}
	if (isError) {
		return <span className={cn(base, "bg-severity-error/15 text-severity-error")}>Error</span>
	}
	if (statusCode === "Ok") {
		return <span className={cn(base, "bg-severity-info/15 text-severity-info")}>OK</span>
	}
	return null
}

interface FlowSpanNodeProps {
	data: FlowNodeData
}

export const FlowSpanNode = memo(function FlowSpanNode({ data }: FlowSpanNodeProps) {
	const { span, isSelected, count, combinedSpans, aggregatedDuration, totalDurationMs } = data

	if (span.isMissing) {
		return (
			<>
				<Handle
					type="target"
					position={Position.Top}
					className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
					isConnectable={false}
				/>
				<div
					className={cn(
						"relative w-[280px] rounded-lg border-2 border-dashed border-muted-foreground/30 bg-card/50",
						"flex flex-col gap-1 px-3 py-2 transition-all duration-200",
						isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background",
					)}
				>
					<div className="flex items-center gap-1.5 min-w-0 text-[11px]">
						<span className="font-semibold text-muted-foreground">Missing Span</span>
						<span className="flex-1" />
						<span className="font-mono text-muted-foreground/60 truncate" title={span.spanId}>
							{span.spanId.slice(0, 8)}
						</span>
					</div>
					<div className="text-[10px] italic text-muted-foreground/50">Not ingested or dropped</div>
				</div>
				<Handle
					type="source"
					position={Position.Bottom}
					className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
					isConnectable={false}
				/>
			</>
		)
	}

	const isCombined = count > 1

	const desc = describeSpan(span)
	const { category, httpInfo, cacheInfo } = desc

	// Detect error state: respect OTel status as source of truth
	// Only fall back to HTTP status >= 500 when OTel status is not explicitly "Ok".
	// A combined group reads as error if any member errors (matches the edge logic).
	const spanIsError = (s: { statusCode: string }, httpError: boolean) =>
		s.statusCode === "Error" || (s.statusCode !== "Ok" && httpError)
	const isError =
		spanIsError(span, httpInfo?.isError ?? false) ||
		(isCombined && combinedSpans.some((s) => s.statusCode === "Error"))

	const primaryText = getPrimaryText(span, desc)
	const { main, tooltip } = formatCombinedDuration(isCombined, span.durationMs, aggregatedDuration)

	// Cost rail: this span's share of the whole trace, sqrt-scaled so small
	// spans stay visible while slow spans still dominate the eye.
	const railDurationMs = isCombined ? aggregatedDuration.avg : span.durationMs
	const costFraction =
		totalDurationMs > 0
			? Math.min(1, Math.max(0.02, Math.sqrt(railDurationMs / totalDurationMs)))
			: 0

	const CategoryIcon = category.Icon

	return (
		<>
			<Handle
				type="target"
				position={Position.Top}
				className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
				isConnectable={false}
			/>

			<div
				className={cn(
					"relative w-[280px] rounded-lg border bg-card shadow-sm transition-all duration-200 hover:shadow-md",
					isError && "border-severity-error/30 bg-severity-error/5 shadow-severity-error/10",
					isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background shadow-md",
					// Combined groups render as a card stack
					isCombined &&
						"before:absolute before:inset-0 before:-z-10 before:translate-x-1.5 before:translate-y-1.5 before:rounded-lg before:border before:bg-card",
				)}
			>
				{isCombined && (
					<span className="absolute -top-2 -right-2 rounded-full border bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground shadow-sm">
						×{count}
					</span>
				)}

				<div className="flex items-center gap-2 p-2 pb-2.5 pr-2.5">
					{/* Category icon chip — same tinted-badge idiom as status chips */}
					<span
						className={cn(
							"flex size-6 shrink-0 items-center justify-center rounded-md",
							isError
								? "bg-severity-error/15 text-severity-error"
								: cn(category.accent.soft, category.accent.text),
						)}
					>
						{category.id === "cache" && cacheInfo?.system ? (
							<CacheSystemIcon system={cacheInfo.system} size={13} />
						) : (
							<CategoryIcon size={13} />
						)}
					</span>

					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						{/* Row 1: operation + status */}
						<div className="flex min-w-0 items-center gap-1.5">
							<span
								className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground"
								title={primaryText}
							>
								{primaryText}
							</span>
							<StatusBadge desc={desc} isError={isError} statusCode={span.statusCode} />
						</div>

						{/* Row 2: service + category label + duration */}
						<div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
							<ServiceDot serviceName={span.serviceName} className="size-1.5" />
							<span className="truncate">{span.serviceName}</span>
							<span className="shrink-0 text-muted-foreground/50">·</span>
							<span className="shrink-0">{category.label}</span>
							<span className="flex-1" />
							<span className="shrink-0 tabular-nums" title={tooltip}>
								{main}
							</span>
						</div>
					</div>
				</div>

				{/* Cost rail: span duration as share of the trace */}
				<div className="absolute inset-x-0 bottom-0 h-[3px] overflow-hidden rounded-b-[7px] bg-muted/40">
					<div
						className={cn("h-full", isError ? "bg-severity-error" : category.accent.rail)}
						style={{ width: `${costFraction * 100}%` }}
					/>
				</div>
			</div>

			<Handle
				type="source"
				position={Position.Bottom}
				className="!opacity-0 !w-0 !h-0 !min-w-0 !min-h-0"
				isConnectable={false}
			/>
		</>
	)
})
