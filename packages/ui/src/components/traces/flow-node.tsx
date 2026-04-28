import { memo } from "react"
import { Handle, Position } from "@xyflow/react"
import {
	CircleXmarkIcon,
	NetworkNodesIcon,
	PulseIcon,
	ChevronRightIcon,
	ChevronLeftIcon,
	CodeIcon,
	type IconComponent,
} from "../icons"

import { cn } from "../../lib/utils"
import { formatDuration } from "../../lib/format"
import { getSpanColorStyle, extractClassName } from "../../lib/colors"
import { getHttpInfo, HTTP_METHOD_COLORS } from "../../lib/http"
import type { FlowNodeData, AggregatedDuration } from "./flow-utils"

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

function getSpanIcon(spanKind: string, isHttpRequest: boolean, isError: boolean): IconComponent {
	if (isError) return CircleXmarkIcon
	if (isHttpRequest) return NetworkNodesIcon

	switch (spanKind) {
		case "SPAN_KIND_SERVER":
			return PulseIcon
		case "SPAN_KIND_CLIENT":
			return ChevronRightIcon
		case "SPAN_KIND_PRODUCER":
			return ChevronRightIcon
		case "SPAN_KIND_CONSUMER":
			return ChevronLeftIcon
		case "SPAN_KIND_INTERNAL":
			return CodeIcon
		default:
			return CodeIcon
	}
}

const SPAN_KIND_LABELS: Record<string, string> = {
	SPAN_KIND_SERVER: "Server",
	SPAN_KIND_CLIENT: "Client",
	SPAN_KIND_PRODUCER: "Producer",
	SPAN_KIND_CONSUMER: "Consumer",
	SPAN_KIND_INTERNAL: "Internal",
}

interface FlowSpanNodeProps {
	data: FlowNodeData
}

export const FlowSpanNode = memo(function FlowSpanNode({ data }: FlowSpanNodeProps) {
	const { span, services, isSelected, count, aggregatedDuration } = data
	const isCombined = count > 1
	const kindLabel = SPAN_KIND_LABELS[span.spanKind] || span.spanKind.replace("SPAN_KIND_", "")
	const httpInfo = getHttpInfo(span.spanName, span.spanAttributes)
	const isHttpRequest = !!httpInfo
	const isError = span.statusCode === "Error" || (span.statusCode !== "Ok" && (httpInfo?.isError ?? false))

	const colorStyle = isError ? {} : getSpanColorStyle(span.spanName, span.serviceName, services)
	const SpanIcon = getSpanIcon(span.spanKind, isHttpRequest, isError)

	const className = extractClassName(span.spanName)
	const functionName = className ? span.spanName.slice(className.length + 1) : span.spanName

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
					"relative w-[280px] shadow-sm transition-all duration-200",
					"flex flex-col overflow-hidden hover:shadow-md",
					isError && "shadow-destructive/10",
					isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-background shadow-md",
				)}
			>
				<div
					className={cn(
						"flex items-center justify-between gap-2 px-3 py-2 text-[11px]",
						isError ? "bg-destructive text-white" : "",
					)}
					style={!isError ? colorStyle : undefined}
				>
					<div className="flex items-center gap-1.5 min-w-0">
						<SpanIcon size={14} className="shrink-0" />
						<span className="font-semibold truncate">{span.serviceName}</span>
					</div>
					<span className="opacity-75 shrink-0">{isHttpRequest ? "HTTP" : kindLabel}</span>
				</div>

				<div
					className={cn(
						"border border-dashed border-t-0",
						isError ? "border-destructive/40" : "border-foreground/20",
					)}
				>
					<div className="flex-1 px-3 py-2.5 bg-card">
						{isHttpRequest && httpInfo ? (
							<>
								<div className="flex items-center gap-2">
									<span
										className={cn(
											"px-2 py-0.5 font-mono text-[11px] font-bold text-white shrink-0",
											HTTP_METHOD_COLORS[httpInfo.method] || "bg-[#5A5248]",
										)}
									>
										{httpInfo.method}
									</span>
									<span
										className="font-mono text-xs text-foreground truncate"
										title={httpInfo.route || span.spanName}
									>
										{httpInfo.route || span.spanName}
									</span>
								</div>
								<div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
									{(() => {
										const { main, tooltip } = formatCombinedDuration(
											isCombined,
											span.durationMs,
											aggregatedDuration,
										)
										return <span title={tooltip}>{main}</span>
									})()}
									{httpInfo.statusCode != null && (
										<span
											className={cn(
												"px-1.5 py-0.5 font-mono font-bold",
												httpInfo.statusCode >= 200 &&
													httpInfo.statusCode < 300 &&
													"bg-severity-info/15 text-severity-info",
												httpInfo.statusCode >= 300 &&
													httpInfo.statusCode < 400 &&
													"bg-chart-p50/15 text-chart-p50",
												httpInfo.statusCode >= 400 &&
													httpInfo.statusCode < 500 &&
													"bg-severity-warn/15 text-severity-warn",
												httpInfo.statusCode >= 500 &&
													"bg-severity-error/15 text-severity-error",
												httpInfo.statusCode < 200 && "text-muted-foreground",
											)}
										>
											{httpInfo.statusCode}
										</span>
									)}
								</div>
							</>
						) : className ? (
							<>
								<div
									className="inline-block px-1.5 py-0.5 text-[10px] font-semibold mb-1"
									style={{
										backgroundColor: `${colorStyle.backgroundColor}20`,
										color: colorStyle.backgroundColor,
									}}
								>
									{className}
								</div>
								<div
									className="font-mono text-xs font-medium truncate text-foreground"
									title={functionName}
								>
									{functionName}
								</div>
								<div className="mt-1.5 text-[11px] text-muted-foreground font-medium">
									{(() => {
										const { main, tooltip } = formatCombinedDuration(
											isCombined,
											span.durationMs,
											aggregatedDuration,
										)
										return <span title={tooltip}>{main}</span>
									})()}
								</div>
							</>
						) : (
							<>
								<div className="font-mono text-xs font-medium truncate" title={span.spanName}>
									{span.spanName}
								</div>
								<div className="mt-1.5 text-[11px] text-muted-foreground font-medium">
									{(() => {
										const { main, tooltip } = formatCombinedDuration(
											isCombined,
											span.durationMs,
											aggregatedDuration,
										)
										return <span title={tooltip}>{main}</span>
									})()}
								</div>
							</>
						)}
					</div>

					<div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-t border-dashed border-foreground/10 text-[10px]">
						{isError ? (
							<span className="px-1.5 py-0.5 text-[10px] font-semibold bg-severity-error/15 text-severity-error">
								Error
							</span>
						) : span.statusCode === "Ok" ||
						  (httpInfo?.statusCode != null &&
								httpInfo.statusCode >= 200 &&
								httpInfo.statusCode < 400) ? (
							<span className="px-1.5 py-0.5 text-[10px] font-semibold bg-severity-info/15 text-severity-info">
								OK
							</span>
						) : (
							<span className="px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
								{span.statusCode}
							</span>
						)}
						{isCombined ? (
							<span className="font-mono text-muted-foreground/60 truncate ml-2">
								{count} spans
							</span>
						) : (
							<span
								className="font-mono text-muted-foreground/60 truncate ml-2"
								title={span.spanId}
							>
								{span.spanId.slice(0, 8)}
							</span>
						)}
					</div>
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
