import type { ReactNode } from "react"
import { Pressable, Text, View } from "react-native"

interface ScreenHeaderProps {
	title: string
	subtitle?: string
	backLabel?: string
	onBack?: () => void
	right?: ReactNode
}

export function ScreenHeader({
	title,
	subtitle,
	backLabel,
	onBack,
	right,
}: ScreenHeaderProps) {
	return (
		<View className="px-5 pt-2 pb-3">
			{backLabel && onBack ? (
				<Pressable
					onPress={onBack}
					className="flex-row items-center mb-2"
					hitSlop={8}
				>
					<Text className="text-sm text-primary font-mono">← {backLabel}</Text>
				</Pressable>
			) : null}
			<View className="flex-row justify-between items-start">
				<View className="flex-1 mr-3">
					<Text
						className="text-2xl font-bold text-foreground font-mono"
						numberOfLines={2}
					>
						{title}
					</Text>
					{subtitle ? (
						<Text
							className="text-xs text-muted-foreground font-mono mt-0.5"
							numberOfLines={2}
						>
							{subtitle}
						</Text>
					) : null}
				</View>
				{right ? (
					<View className="flex-row items-center gap-2">{right}</View>
				) : null}
			</View>
		</View>
	)
}
