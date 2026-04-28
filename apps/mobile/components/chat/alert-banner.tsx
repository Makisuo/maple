import { Text, View } from "react-native"
import { type AlertContext, severityColor, signalLabel } from "../../lib/alert-context"

interface AlertBannerProps {
	alert: AlertContext
}

function formatComparator(c: string): string {
	switch (c) {
		case "gt":
			return ">"
		case "gte":
			return "≥"
		case "lt":
			return "<"
		case "lte":
			return "≤"
		default:
			return c
	}
}

export function AlertBanner({ alert }: AlertBannerProps) {
	const sev = severityColor(alert.severity)
	const observed = alert.value === null ? "n/a" : String(alert.value)
	const threshold = `${formatComparator(alert.comparator)} ${alert.threshold}`
	return (
		<View className="flex-row mx-4 mb-2 mt-1 overflow-hidden rounded-md border border-border bg-card">
			<View style={{ width: 3, backgroundColor: sev }} />
			<View className="flex-1 gap-1 px-3 py-2.5">
				<View className="flex-row items-center gap-2">
					<Text className="font-mono text-[10px]" style={{ color: sev, letterSpacing: 1.5 }}>
						{alert.severity.toUpperCase()} · {alert.eventType.toUpperCase()}
					</Text>
					<Text
						className="font-mono text-[10px] text-muted-foreground"
						style={{ letterSpacing: 1.2 }}
					>
						ATTACHED
					</Text>
				</View>
				<Text className="font-mono text-[13px] font-bold text-foreground" numberOfLines={1}>
					{alert.ruleName}
				</Text>
				<Text className="font-mono text-[11px] text-muted-foreground" numberOfLines={1}>
					{signalLabel(alert.signalType)} · observed {observed} {threshold} · {alert.windowMinutes}m
					window
				</Text>
			</View>
		</View>
	)
}
