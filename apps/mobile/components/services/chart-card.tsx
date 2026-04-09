import type { ReactNode } from "react"
import { Text, View } from "react-native"

interface ChartCardProps {
	title: string
	summary: ReactNode
	children: ReactNode
}

export function ChartCard({ title, summary, children }: ChartCardProps) {
	return (
		<View className="bg-card rounded-xl border border-border p-4">
			<View className="flex-row items-center justify-between mb-3">
				<Text className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
					{title}
				</Text>
				{summary}
			</View>
			{children}
		</View>
	)
}
