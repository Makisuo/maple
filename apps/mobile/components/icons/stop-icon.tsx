import Svg, { Rect } from "react-native-svg"
import { colors } from "../../lib/theme"

interface IconProps {
	size?: number
	color?: string
}

export function StopIcon({ size = 12, color = colors.foreground }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24">
			<Rect x="4" y="4" width="16" height="16" rx="2" fill={color} />
		</Svg>
	)
}
