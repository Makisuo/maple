import { Text, View } from "react-native"

interface EmptyStateProps {
	tagline?: string
}

export function EmptyState({ tagline }: EmptyStateProps) {
	return (
		<View className="flex-1 items-center justify-center gap-4 px-6">
			<Text
				className="font-mono font-bold text-primary"
				style={{ opacity: 0.4, fontSize: 72, lineHeight: 80 }}
			>
				▌
			</Text>
			<View className="items-center gap-1">
				<Text className="font-mono text-[10px] text-muted-foreground" style={{ letterSpacing: 2 }}>
					MAPLE AI
				</Text>
				<Text
					className="font-mono text-[13px] text-center text-muted-foreground"
					style={{ maxWidth: 280 }}
				>
					{tagline ?? "Ask about traces, logs, errors, and services across your fleet."}
				</Text>
			</View>
		</View>
	)
}
