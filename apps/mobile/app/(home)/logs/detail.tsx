import { Pressable, ScrollView, Text, View } from "react-native"
import { useRouter } from "expo-router"
import { getSelectedLog } from "../../../lib/log-detail-store"
import { severityColors } from "../../../lib/theme"
import { formatLogTimestamp } from "../../../lib/format"
import { Screen, useScreenBottomPadding } from "../../../components/ui/screen"
import { ScreenHeader } from "../../../components/ui/screen-header"

export default function LogDetailScreen() {
	const router = useRouter()
	const log = getSelectedLog()
	const bottomPadding = useScreenBottomPadding()

	if (!log) {
		return (
			<Screen>
				<ScreenHeader title="Log Detail" backLabel="Logs" onBack={() => router.back()} />
				<View className="flex-1 items-center justify-center px-5">
					<Text className="text-sm text-muted-foreground font-mono">Log not found</Text>
				</View>
			</Screen>
		)
	}

	const severity = log.severityText.toUpperCase()
	const color = severityColors[severity] ?? severityColors.TRACE
	const logAttrs = Object.entries(log.logAttributes)
	const resourceAttrs = Object.entries(log.resourceAttributes)

	return (
		<Screen>
			<ScreenHeader title="Log Detail" backLabel="Logs" onBack={() => router.back()} />

			{/* Header pills */}
			<View className="px-5 pb-3">
				<View className="flex-row flex-wrap gap-2">
					<View className="rounded px-2.5 py-1" style={{ backgroundColor: `${color}20` }}>
						<Text className="text-xs font-bold font-mono" style={{ color }}>
							{severity}
						</Text>
					</View>
					<Pill label={formatLogTimestamp(log.timestamp)} />
					<Pill label={log.serviceName} />
				</View>
			</View>

			<ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: bottomPadding }}>
				{/* Message */}
				<View className="px-5 pt-4">
					<SectionLabel>Message</SectionLabel>
					<Text className="text-sm text-foreground font-mono leading-5" selectable>
						{log.body}
					</Text>
				</View>

				{/* Identifiers */}
				{(log.traceId || log.spanId) && (
					<View className="px-5 pt-6">
						<SectionLabel>Identifiers</SectionLabel>
						{log.traceId !== "" && (
							<View className="flex-row py-1.5">
								<Text className="text-xs text-muted-foreground font-mono w-2/5">
									Trace ID
								</Text>
								<Pressable
									onPress={() => router.push(`/(home)/traces/${log.traceId}`)}
									style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
									className="flex-1"
								>
									<Text className="text-xs text-primary font-mono" numberOfLines={1}>
										{log.traceId}
									</Text>
								</Pressable>
							</View>
						)}
						{log.spanId !== "" && (
							<View className="flex-row py-1.5">
								<Text className="text-xs text-muted-foreground font-mono w-2/5">Span ID</Text>
								<Text className="text-xs text-foreground font-mono flex-1" numberOfLines={1}>
									{log.spanId}
								</Text>
							</View>
						)}
					</View>
				)}

				{/* Log Attributes */}
				{logAttrs.length > 0 && (
					<View className="px-5 pt-6">
						<SectionLabel>Log Attributes</SectionLabel>
						{logAttrs.map(([key, value]) => (
							<View key={key} className="flex-row py-1.5">
								<Text
									className="text-xs text-muted-foreground font-mono w-2/5"
									numberOfLines={1}
								>
									{key}
								</Text>
								<Text className="text-xs text-foreground font-mono flex-1" numberOfLines={2}>
									{value}
								</Text>
							</View>
						))}
					</View>
				)}

				{/* Resource Attributes */}
				{resourceAttrs.length > 0 && (
					<View className="px-5 pt-6">
						<SectionLabel>Resource Attributes</SectionLabel>
						{resourceAttrs.map(([key, value]) => (
							<View key={key} className="flex-row py-1.5">
								<Text
									className="text-xs text-muted-foreground font-mono w-2/5"
									numberOfLines={1}
								>
									{key}
								</Text>
								<Text className="text-xs text-foreground font-mono flex-1" numberOfLines={2}>
									{value}
								</Text>
							</View>
						))}
					</View>
				)}
			</ScrollView>
		</Screen>
	)
}

function Pill({ label }: { label: string }) {
	return (
		<View className="rounded px-2.5 py-1" style={{ backgroundColor: "rgba(255,255,255,0.08)" }}>
			<Text className="text-xs text-muted-foreground font-mono">{label}</Text>
		</View>
	)
}

function SectionLabel({ children }: { children: string }) {
	return (
		<Text className="text-xs font-bold text-muted-foreground font-mono mb-2 uppercase">{children}</Text>
	)
}
