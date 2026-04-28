import { Pressable, Text, View } from "react-native"
import { useRouter } from "expo-router"
import type { Log } from "../../lib/api"
import { hapticLight } from "../../lib/haptics"
import { severityColors } from "../../lib/theme"
import { formatLogTimestamp } from "../../lib/format"
import { setSelectedLog } from "../../lib/log-detail-store"

export function LogRow({ item }: { item: Log }) {
	const router = useRouter()
	const severity = item.severityText.toUpperCase()
	const color = severityColors[severity] ?? severityColors.TRACE

	return (
		<Pressable
			onPress={() => {
				hapticLight()
				setSelectedLog(item)
				router.push("/(home)/logs/detail")
			}}
			style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
		>
			<View className="flex-row px-5 py-2.5 border-b border-border">
				<View className="w-1 rounded-full mr-3 self-stretch" style={{ backgroundColor: color }} />
				<View className="flex-1">
					<View className="flex-row items-center mb-1">
						<Text className="text-[10px] font-bold font-mono mr-2" style={{ color }}>
							{severity}
						</Text>
						<Text className="text-[10px] text-muted-foreground font-mono">
							{formatLogTimestamp(item.timestamp)}
						</Text>
					</View>
					<Text className="text-xs text-foreground font-mono leading-4" numberOfLines={2}>
						{item.body}
					</Text>
					<Text className="text-[10px] text-muted-foreground font-mono mt-1">
						{item.serviceName}
					</Text>
				</View>
			</View>
		</Pressable>
	)
}
