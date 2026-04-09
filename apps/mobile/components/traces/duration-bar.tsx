import { View } from "react-native"

interface DurationBarProps {
	leftPercent: number
	widthPercent: number
	color: string
}

export function DurationBar({ leftPercent, widthPercent, color }: DurationBarProps) {
	return (
		<View className="h-[5px] rounded-full overflow-hidden mt-1.5" style={{ backgroundColor: "#2a2520" }}>
			<View
				style={{
					position: "absolute",
					left: `${leftPercent}%`,
					width: `${Math.max(widthPercent, 1)}%`,
					height: "100%",
					borderRadius: 4,
					backgroundColor: color,
				}}
			/>
		</View>
	)
}
