import { Pressable, Text, View } from "react-native"
import type { SpanNode } from "../../lib/api"
import { hapticLight } from "../../lib/haptics"
import { getServiceColor, getStatusColor, getStatusBgColor } from "../../lib/colors"
import { formatDuration } from "../../lib/format"
import { DurationBar } from "./duration-bar"

const KIND_LABELS: Record<string, string> = {
	SPAN_KIND_SERVER: "Server",
	SPAN_KIND_CLIENT: "Client",
	SPAN_KIND_PRODUCER: "Producer",
	SPAN_KIND_CONSUMER: "Consumer",
	SPAN_KIND_INTERNAL: "Internal",
}

function getBarColor(span: SpanNode): string {
	if (span.statusCode === "Error") return "#c45a3c"
	const httpStatus =
		span.spanAttributes["http.status_code"] || span.spanAttributes["http.response.status_code"]
	if (httpStatus) {
		const code = parseInt(httpStatus, 10)
		if (code >= 500) return "#c45a3c"
		if (code >= 400) return "#d4a843"
	}
	return getServiceColor(span.serviceName)
}

function getSpanStatusBadge(span: SpanNode): { label: string; color: string; bgColor: string } | null {
	const httpStatus =
		span.spanAttributes["http.status_code"] || span.spanAttributes["http.response.status_code"]
	if (httpStatus) {
		const code = parseInt(httpStatus, 10)
		return {
			label: httpStatus,
			color: getStatusColor(code, span.statusCode === "Error"),
			bgColor: getStatusBgColor(code, span.statusCode === "Error"),
		}
	}

	const cacheHit = span.spanAttributes["cache.hit"]
	if (cacheHit === "true") {
		return { label: "HIT", color: "#d4a843", bgColor: "rgba(212, 168, 67, 0.2)" }
	}

	if (span.statusCode === "Error") {
		return { label: "Error", color: "#c45a3c", bgColor: "rgba(196, 90, 60, 0.2)" }
	}

	if (span.statusCode === "Ok") {
		return { label: "Ok", color: "#5cb88a", bgColor: "rgba(92, 184, 138, 0.2)" }
	}

	return null
}

interface SpanRowDetailProps {
	span: SpanNode
	isExpanded: boolean
	onToggle: () => void
	totalDurationMs: number
	traceStartTime: string
}

export function SpanRowDetail({
	span,
	isExpanded,
	onToggle,
	totalDurationMs,
	traceStartTime,
}: SpanRowDetailProps) {
	const serviceColor = getServiceColor(span.serviceName)
	const kindLabel = KIND_LABELS[span.spanKind] ?? ""
	const hasChildren = span.children.length > 0
	const badge = getSpanStatusBadge(span)

	const traceStartMs = new Date(traceStartTime).getTime()
	const spanStartMs = new Date(span.startTime).getTime()
	const leftPercent = totalDurationMs > 0 ? ((spanStartMs - traceStartMs) / totalDurationMs) * 100 : 0
	const widthPercent = totalDurationMs > 0 ? (span.durationMs / totalDurationMs) * 100 : 0

	return (
		<Pressable
			onPress={
				hasChildren
					? () => {
							hapticLight()
							onToggle()
						}
					: undefined
			}
			style={({ pressed }) => ({ opacity: pressed && hasChildren ? 0.7 : 1 })}
		>
			<View className="py-3 px-5" style={{ paddingLeft: 20 + span.depth * 16 }}>
				{/* Row 1: Service + Kind + Duration + Status */}
				<View className="flex-row items-center justify-between">
					<View className="flex-row items-center flex-1">
						{hasChildren ? (
							<Text className="text-xs text-muted-foreground font-mono w-4 mr-1">
								{isExpanded ? "\u25BC" : "\u25B6"}
							</Text>
						) : (
							<View className="w-4 mr-1 items-center">
								<View style={{ width: 1, height: 14, backgroundColor: serviceColor }} />
							</View>
						)}
						<Text className="text-xs font-bold font-mono" style={{ color: serviceColor }}>
							{span.serviceName}
						</Text>
						{kindLabel ? (
							<Text className="text-[10px] text-muted-foreground font-mono ml-1.5">
								{kindLabel}
							</Text>
						) : null}
					</View>
					<View className="flex-row items-center gap-2">
						<Text className="text-xs text-muted-foreground font-mono">
							{formatDuration(span.durationMs)}
						</Text>
						{badge && (
							<View
								className="rounded px-1.5 py-0.5"
								style={{ backgroundColor: badge.bgColor }}
							>
								<Text
									className="text-[10px] font-bold font-mono"
									style={{ color: badge.color }}
								>
									{badge.label}
								</Text>
							</View>
						)}
					</View>
				</View>

				{/* Row 2: Span name */}
				<Text
					className="text-sm text-foreground font-mono mt-1"
					numberOfLines={1}
					style={{ marginLeft: 20 }}
				>
					{span.spanName}
				</Text>

				{/* Row 3: Duration bar */}
				<View style={{ marginLeft: 20 }}>
					<DurationBar
						leftPercent={Math.max(0, Math.min(100, leftPercent))}
						widthPercent={Math.max(0, Math.min(100 - leftPercent, widthPercent))}
						color={getBarColor(span)}
					/>
				</View>
			</View>
		</Pressable>
	)
}
