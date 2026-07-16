import * as React from "react"
import { ChevronRightIcon, ChevronDownIcon, GlobeIcon } from "../icons"

import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { cn } from "../../lib/utils"
import { formatDuration } from "../../lib/format"
import { getServiceLegendColor } from "../../lib/colors"
import { getCacheInfo, cacheResultStyles } from "../../lib/cache"
import { getHttpInfo, HTTP_METHOD_COLORS } from "../../lib/http"
import { getCloudPlatform, outcomeBadgeStyle } from "../../lib/cloud-platforms"
import { PixelDurationBar } from "./pixel-duration-bar"
import { countDescendants } from "./auto-collapse"
import type { SpanNode } from "../../lib/types"

interface SpanRowProps {
	span: SpanNode
	totalDurationMs: number
	traceStartTime: string
	services: string[]
	expanded: boolean
	onToggle: (span: SpanNode) => void
	isSelected?: boolean
	onSelect?: (span: SpanNode) => void
}

const statusStyles: Record<string, string> = {
	Ok: "bg-severity-info/15 text-severity-info border-severity-info/30",
	Error: "bg-severity-error/15 text-severity-error border-severity-error/30",
	Unset: "bg-muted text-muted-foreground border-border",
}

const kindLabels: Record<string, string> = {
	SPAN_KIND_SERVER: "Server",
	SPAN_KIND_CLIENT: "Client",
	SPAN_KIND_PRODUCER: "Producer",
	SPAN_KIND_CONSUMER: "Consumer",
	SPAN_KIND_INTERNAL: "Internal",
}

function SpanRowImpl({
	span,
	totalDurationMs,
	traceStartTime,
	services,
	expanded,
	onToggle,
	isSelected,
	onSelect,
}: SpanRowProps) {
	const hasChildren = span.children.length > 0

	if (span.isMissing) {
		return (
			<div
				className={cn(
					"@container/row group flex items-center border-b border-dashed py-1.5 px-2 bg-muted/30",
					isSelected && "bg-primary/5 border-l-2 border-l-primary",
				)}
			>
				<div className="flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
					{span.depth > 0 && <div style={{ width: `${span.depth * 24}px` }} className="shrink-0" />}

					{hasChildren ? (
						<Button
							variant="ghost"
							size="icon-sm"
							className="size-6 shrink-0"
							aria-label={expanded ? "Collapse span" : "Expand span"}
							onClick={(e) => {
								e.stopPropagation()
								onToggle(span)
							}}
						>
							{expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
						</Button>
					) : (
						<div className="w-6 shrink-0" />
					)}

					<Badge
						variant="outline"
						className="shrink-0 font-mono text-[10px] px-1.5 border-dashed text-muted-foreground"
					>
						missing
					</Badge>

					<span
						className="flex-1 truncate font-mono text-xs italic text-muted-foreground"
						title={`Missing span: ${span.spanId}`}
					>
						Missing Span
					</span>
				</div>

				<div className="flex items-center gap-2 shrink-0 ml-2">
					<div className="hidden w-48 @min-[560px]/row:block" />
					<span
						className="w-16 text-right font-mono text-[10px] text-muted-foreground/50 truncate"
						title={span.spanId}
					>
						{span.spanId.slice(0, 8)}
					</span>
					<div className="w-14" />
				</div>
			</div>
		)
	}

	// Calculate waterfall bar position and width
	const traceStartMs = new Date(traceStartTime).getTime()
	const spanStartMs = new Date(span.startTime).getTime()

	const leftPercent = totalDurationMs > 0 ? ((spanStartMs - traceStartMs) / totalDurationMs) * 100 : 0

	const widthPercent = totalDurationMs > 0 ? (span.durationMs / totalDurationMs) * 100 : 0

	const cacheInfo = getCacheInfo(span.spanAttributes)
	const httpInfo = getHttpInfo(span)
	const platform = getCloudPlatform(span.spanAttributes)
	const statusStyle = statusStyles[span.statusCode] ?? statusStyles.Unset
	const kindLabel = kindLabels[span.spanKind] ?? span.spanKind?.replace("SPAN_KIND_", "") ?? "Unknown"

	const barColor =
		httpInfo?.statusCode && httpInfo.statusCode >= 500
			? "bg-destructive"
			: httpInfo?.statusCode && httpInfo.statusCode >= 400
				? "bg-severity-warn"
				: span.statusCode === "Error"
					? "bg-destructive"
					: "bg-primary"

	return (
		<div
			className={cn(
				"@container/row group flex items-center border-b py-1.5 hover:bg-muted/50 cursor-pointer px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				span.statusCode === "Error" && "bg-destructive/5",
				isSelected && "bg-primary/5 border-l-2 border-l-primary",
			)}
			role="button"
			tabIndex={0}
			onClick={() => onSelect?.(span)}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault()
					onSelect?.(span)
				}
			}}
		>
			{/* Left section: Toggle + Service + Kind + Span Name (variable width) */}
			{/* overflow-hidden so the shrink-0 children clip rather than paint over the right section */}
			<div className="@container flex items-center gap-2 flex-1 min-w-0 overflow-hidden">
				{/* Indentation spacer based on depth */}
				{span.depth > 0 && <div style={{ width: `${span.depth * 24}px` }} className="shrink-0" />}

				{hasChildren ? (
					<Button
						variant="ghost"
						size="icon-sm"
						className="size-6 shrink-0"
						aria-label={expanded ? "Collapse span" : "Expand span"}
						onClick={(e) => {
							e.stopPropagation()
							onToggle(span)
						}}
					>
						{expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
					</Button>
				) : (
					<div className="w-6 shrink-0" />
				)}

				<Badge variant="outline" className="shrink-0 font-mono text-[10px] px-1.5 gap-1">
					{platform && (
						<platform.Icon
							size={11}
							className={cn("shrink-0", platform.accentClassName)}
							aria-label={platform.label}
						/>
					)}
					<span style={{ color: getServiceLegendColor(span.serviceName, services) }}>
						{span.serviceName}
					</span>
					<span className="text-muted-foreground">·</span>
					{kindLabel}
				</Badge>

				{platform?.edge && (
					<span
						className="hidden @min-[600px]:inline-flex items-center gap-1 shrink-0 font-mono text-[10px] text-muted-foreground"
						title={platform.location ?? undefined}
					>
						<GlobeIcon size={10} className="shrink-0" />
						{platform.edge}
					</span>
				)}

				{httpInfo ? (
					<span
						className="flex-1 flex items-center gap-1.5 min-w-0 font-mono text-xs"
						title={httpInfo.route || span.spanName}
					>
						<span
							className={cn(
								"px-1 py-0.5 rounded text-[10px] font-bold text-white shrink-0 leading-none hidden @min-[500px]:inline-flex",
								HTTP_METHOD_COLORS[httpInfo.method] || "bg-muted-foreground",
							)}
						>
							{httpInfo.method}
						</span>
						<span className="truncate">{httpInfo.route || span.spanName}</span>
					</span>
				) : (
					<span className="flex-1 truncate font-mono text-xs" title={span.spanName}>
						{span.spanName}
					</span>
				)}

				{hasChildren && !expanded && (
					<span className="shrink-0 text-[10px] text-muted-foreground">
						+{countDescendants(span)}
					</span>
				)}
			</div>

			{/* Right section: Duration bar + Duration text + Status (fixed widths, anchored right) */}
			<div className="flex items-center gap-2 shrink-0 ml-2">
				<PixelDurationBar
					leftPercent={leftPercent}
					widthPercent={Math.max(widthPercent, 1)}
					color={barColor}
					className="hidden @min-[560px]/row:flex"
				/>

				<span className="w-16 text-right font-mono text-xs text-muted-foreground">
					{formatDuration(span.durationMs)}
				</span>

				{platform?.outcome?.bad && (
					<Badge
						variant="outline"
						className={cn(
							"text-[10px] justify-center font-medium px-1.5 shrink-0",
							outcomeBadgeStyle(true),
						)}
						title={`${platform.label} outcome`}
					>
						{platform.outcome.value}
					</Badge>
				)}

				{cacheInfo?.result ? (
					<Badge
						variant="outline"
						className={cn(
							"text-[10px] w-14 justify-center font-medium",
							cacheResultStyles[cacheInfo.result],
						)}
					>
						{cacheInfo.result === "hit" ? "HIT" : "MISS"}
					</Badge>
				) : httpInfo?.statusCode ? (
					<span
						className={cn(
							"w-14 text-center font-mono text-xs font-medium",
							httpInfo.statusCode >= 500
								? "text-severity-error"
								: httpInfo.statusCode >= 400
									? "text-severity-warn"
									: httpInfo.statusCode >= 300
										? "text-chart-p50"
										: "text-severity-info",
						)}
					>
						{httpInfo.statusCode}
					</span>
				) : (
					<Badge
						variant="outline"
						className={cn("text-[10px] w-14 justify-center font-medium", statusStyle)}
					>
						{span.statusCode || "Unset"}
					</Badge>
				)}
			</div>
		</div>
	)
}

export const SpanRow = React.memo(SpanRowImpl)
