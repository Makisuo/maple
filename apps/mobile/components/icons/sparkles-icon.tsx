import Svg, { Path } from "react-native-svg"
import { colors } from "../../lib/theme"

interface IconProps {
	size?: number
	color?: string
}

export function SparklesIcon({ size = 16, color = colors.foreground }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24">
			<Path
				fill={color}
				d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2z"
			/>
			<Path fill={color} d="M19 15l.9 2.6L22.5 18.5l-2.6.9L19 22l-.9-2.6L15.5 18.5l2.6-.9L19 15z" />
		</Svg>
	)
}
