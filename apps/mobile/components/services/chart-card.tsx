import type { ReactNode } from "react"
import { Text, View } from "react-native"
import { Card } from "../ui/card"

interface ChartCardProps {
	title: string
	summary: ReactNode
	children: ReactNode
}

export function ChartCard({ title, summary, children }: ChartCardProps) {
	return (
		<Card padding="md">
			<View className="flex-row items-center justify-between mb-3">
				<Text className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
					{title}
				</Text>
				{summary}
			</View>
			{children}
		</Card>
	)
}
