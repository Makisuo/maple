import Svg, { Path } from "react-native-svg"
import { colors } from "../../lib/theme"

interface IconProps {
	size?: number
	color?: string
}

export function SendIcon({ size = 14, color = colors.foreground }: IconProps) {
	return (
		<Svg width={size} height={size} viewBox="0 0 24 24">
			<Path fill={color} d="M3 11l18-8-8 18-2-8-8-2z" />
		</Svg>
	)
}
