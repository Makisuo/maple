import type { IconProps } from "./icon"

const MARKS = [
	{
		brand: "#36C5F0",
		d: "M9.04 2.5A2.04 2.04 0 0 0 7 4.54a2.04 2.04 0 0 0 2.04 2.04h2.04V4.54A2.04 2.04 0 0 0 9.04 2.5m0 5.44H3.6a2.04 2.04 0 0 0-2.04 2.04a2.04 2.04 0 0 0 2.04 2.04h5.44a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04",
	},
	{
		brand: "#2EB67D",
		d: "M21.5 9.98a2.04 2.04 0 0 0-2.04-2.04a2.04 2.04 0 0 0-2.04 2.04v2.04h2.04a2.04 2.04 0 0 0 2.04-2.04m-5.44 0V4.54A2.04 2.04 0 0 0 14.02 2.5a2.04 2.04 0 0 0-2.04 2.04v5.44a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04",
	},
	{
		brand: "#ECB22E",
		d: "M14.02 21.5a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04h-2.04v2.04a2.04 2.04 0 0 0 2.04 2.04m0-5.44h5.44a2.04 2.04 0 0 0 2.04-2.04a2.04 2.04 0 0 0-2.04-2.04h-5.44a2.04 2.04 0 0 0-2.04 2.04a2.04 2.04 0 0 0 2.04 2.04",
	},
	{
		brand: "#E01E5A",
		d: "M1.56 14.02a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04v-2.04H3.6a2.04 2.04 0 0 0-2.04 2.04m5.44 0v5.44a2.04 2.04 0 0 0 2.04 2.04a2.04 2.04 0 0 0 2.04-2.04v-5.44a2.04 2.04 0 0 0-2.04-2.04a2.04 2.04 0 0 0-2.04 2.04",
	},
] as const

interface SlackIconProps extends IconProps {
	/**
	 * Render the mark in `currentColor` instead of the four brand hues — for
	 * surfaces that own the color (inside a filled button, as a dimmed backer
	 * glyph). The path fills win over inherited color, so tinting a full-color
	 * mark via `className`/`color` does nothing; this is the only monochrome path.
	 */
	monochrome?: boolean
}

/**
 * The Slack mark. Rendered in its four brand hues by default (multicolor brand
 * marks are the convention here — see `cloudflare.tsx`, `clickhouse.tsx`), which
 * means the fills are fixed and `className`/`color` cannot tint it. Pass
 * `monochrome` when the glyph has to inherit its surface's text color.
 */
function SlackIcon({ size = 24, className, monochrome = false, ...props }: SlackIconProps) {
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
			{MARKS.map((mark) => (
				<path key={mark.brand} fill={monochrome ? "currentColor" : mark.brand} d={mark.d} />
			))}
		</svg>
	)
}

/**
 * Monochrome Slack mark as a plain icon component — for the
 * `ComponentType<{ size, className }>` slots (catalog entries, icon plates) that
 * can't pass the `monochrome` prop themselves.
 */
function SlackMonoIcon({ size = 24, className, ...props }: IconProps) {
	return <SlackIcon size={size} className={className} monochrome {...props} />
}

export { SlackIcon, SlackMonoIcon }
