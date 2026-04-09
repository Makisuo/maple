import type { ReactNode } from "react"
import { Text, View } from "react-native"

interface SectionHeaderProps {
	children: ReactNode
	right?: ReactNode
}

export function SectionHeader({ children, right }: SectionHeaderProps) {
	if (right) {
		return (
			<View className="flex-row items-center justify-between mb-2">
				<Text className="text-xs text-muted-foreground font-mono uppercase tracking-widest">
					{children}
				</Text>
				{right}
			</View>
		)
	}

	return (
		<Text className="text-xs text-muted-foreground font-mono uppercase tracking-widest mb-2">
			{children}
		</Text>
	)
}
