import { Text, View } from "react-native"
import type { Trace } from "../../lib/api"
import { formatDuration, formatRelativeTime } from "../../lib/format"

const HTTP_METHOD_COLORS: Record<string, string> = {
	GET: "#4A9EFF",
	POST: "#E8872B",
	PUT: "#4AA865",
	PATCH: "#8A7F72",
	DELETE: "#E85D4A",
	HEAD: "#8A7F72",
	OPTIONS: "#5A5248",
}

const SERVICE_HUES = [
	250, 185, 155, 130, 90, 60, 45, 25, 0, 340, 320, 290, 270, 260, 210, 230,
]

function hashString(str: string): number {
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash)
	}
	return Math.abs(hash)
}

function hslToHex(h: number, s: number, l: number): string {
	const a = s * Math.min(l, 1 - l)
	const f = (n: number) => {
		const k = (n + h / 30) % 12
		const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
		return Math.round(255 * color).toString(16).padStart(2, "0")
	}
	return `#${f(0)}${f(8)}${f(4)}`
}

function getServiceColor(serviceName: string): string {
	const index = hashString(serviceName) % SERVICE_HUES.length
	const hue = SERVICE_HUES[index]
	return hslToHex(hue, 0.5, 0.55)
}

function getStatusColor(statusCode: number | null, hasError: boolean): string {
	if (hasError || (statusCode != null && statusCode >= 500)) return "#c45a3c"
	if (statusCode != null && statusCode >= 400) return "#d4a843"
	return "#5cb88a"
}

function getStatusBgColor(statusCode: number | null, hasError: boolean): string {
	if (hasError || (statusCode != null && statusCode >= 500)) return "rgba(196, 90, 60, 0.2)"
	if (statusCode != null && statusCode >= 400) return "rgba(212, 168, 67, 0.2)"
	return "rgba(92, 184, 138, 0.2)"
}

export function TraceRow({ trace }: { trace: Trace }) {
	const method = trace.http?.method
	const route = trace.http?.route ?? trace.rootSpanName
	const statusCode = trace.http?.statusCode
	const serviceName = trace.services[0] ?? "unknown"
	const serviceColor = getServiceColor(serviceName)

	return (
		<View className="px-5 py-3">
			{/* Row 1: Method + Route + Status */}
			<View className="flex-row justify-between items-center">
				<View className="flex-row items-center flex-1 mr-3">
					{method && (
						<View
							className="rounded px-1.5 py-0.5 mr-2"
							style={{ backgroundColor: HTTP_METHOD_COLORS[method] ?? "#5A5248" }}
						>
							<Text className="text-[10px] font-bold text-white font-mono">
								{method}
							</Text>
						</View>
					)}
					<Text
						className="text-sm font-medium text-foreground font-mono flex-1"
						numberOfLines={1}
					>
						{route}
					</Text>
				</View>
				{statusCode != null && (
					<View
						className="rounded px-1.5 py-0.5"
						style={{ backgroundColor: getStatusBgColor(statusCode, trace.hasError) }}
					>
						<Text
							className="text-[10px] font-bold font-mono"
							style={{ color: getStatusColor(statusCode, trace.hasError) }}
						>
							{statusCode}
						</Text>
					</View>
				)}
			</View>

			{/* Row 2: Service · Duration · Spans · Time */}
			<View className="flex-row items-center mt-1.5">
				<Text className="text-xs font-mono" style={{ color: serviceColor }}>
					{serviceName}
				</Text>
				<Text className="text-xs text-muted-foreground font-mono mx-1">·</Text>
				<Text className="text-xs text-muted-foreground font-mono">
					{formatDuration(trace.durationMs)}
				</Text>
				<Text className="text-xs text-muted-foreground font-mono mx-1">·</Text>
				<Text className="text-xs text-muted-foreground font-mono">
					{trace.spanCount} {trace.spanCount === 1 ? "span" : "spans"}
				</Text>
				<Text className="text-xs text-muted-foreground font-mono mx-1">·</Text>
				<Text className="text-xs text-muted-foreground font-mono">
					{formatRelativeTime(trace.startTime)}
				</Text>
			</View>

			{/* Row 3: Span timeline bar */}
			<View className="flex-row h-1.5 rounded-full overflow-hidden mt-2">
				{trace.services.length > 0 ? (
					trace.services.map((service) => (
						<View
							key={service}
							style={{ flex: 1, backgroundColor: getServiceColor(service) }}
						/>
					))
				) : (
					<View style={{ flex: 1, backgroundColor: serviceColor }} />
				)}
			</View>
		</View>
	)
}
