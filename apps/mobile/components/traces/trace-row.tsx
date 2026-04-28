import { Pressable, Text, View } from "react-native"
import { useRouter } from "expo-router"
import type { Trace } from "../../lib/api"
import { hapticLight } from "../../lib/haptics"
import { HTTP_METHOD_COLORS, getServiceColor, getStatusColor, getStatusBgColor } from "../../lib/colors"
import { formatDuration, formatRelativeTime } from "../../lib/format"

export function TraceRow({ trace }: { trace: Trace }) {
	const router = useRouter()
	const method = trace.http?.method
	const route = trace.http?.route ?? trace.rootSpanName
	const statusCode = trace.http?.statusCode
	const serviceName = trace.services[0] ?? "unknown"
	const serviceColor = getServiceColor(serviceName)

	return (
		<Pressable
			onPress={() => {
				hapticLight()
				router.push(`/(home)/traces/${trace.traceId}`)
			}}
			style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
		>
			<View className="px-5 py-3">
				{/* Row 1: Method + Route + Status */}
				<View className="flex-row justify-between items-center">
					<View className="flex-row items-center flex-1 mr-3">
						{method && (
							<View
								className="rounded px-1.5 py-0.5 mr-2"
								style={{ backgroundColor: HTTP_METHOD_COLORS[method] ?? "#5A5248" }}
							>
								<Text className="text-[10px] font-bold text-white font-mono">{method}</Text>
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
		</Pressable>
	)
}
