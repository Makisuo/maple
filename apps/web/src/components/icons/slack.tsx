import type { IconProps } from "./icon"

/**
 * The Slack mark, rendered in its four brand hues. Uses fixed brand colors
 * rather than `currentColor` because the logo is unmistakable only in color;
 * consumers that need a monochrome glyph should tint via `className`/`color`.
 */
function SlackIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			aria-hidden="true"
			{...props}
		>
			<path
				fill="#36C5F0"
				d="M9.04 2.5A2.04 2.04 0 0 0 7 4.54a2.04 2.04 0 0 0 2.04 2.04h2.04V4.54A2.04 2.04 0 0 0 9.04 2.5m0 5.44H3.6a2.04 2.04 0 0 0-2.04 2.04a2.04 2.04 0 0 0 2.04 2.04h5.44a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04"
			/>
			<path
				fill="#2EB67D"
				d="M21.5 9.98a2.04 2.04 0 0 0-2.04-2.04a2.04 2.04 0 0 0-2.04 2.04v2.04h2.04a2.04 2.04 0 0 0 2.04-2.04m-5.44 0V4.54A2.04 2.04 0 0 0 14.02 2.5a2.04 2.04 0 0 0-2.04 2.04v5.44a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04"
			/>
			<path
				fill="#ECB22E"
				d="M14.02 21.5a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04h-2.04v2.04a2.04 2.04 0 0 0 2.04 2.04m0-5.44h5.44a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04h-5.44a2.04 2.04 0 0 0-2.04 2.04a2.04 2.04 0 0 0 2.04 2.04"
			/>
			<path
				fill="#E01E5A"
				d="M1.56 14.02a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04v-2.04H3.6a2.04 2.04 0 0 0-2.04 2.04m5.44 0v5.44a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04v-5.44a2.04 2.04 0 0 0-2.04-2.04a2.04 2.04 0 0 0-2.04 2.04"
			/>
		</svg>
	)
}
export { SlackIcon }
