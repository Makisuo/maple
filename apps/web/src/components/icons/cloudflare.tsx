import type { IconProps } from "./icon"

interface CloudflareIconProps extends IconProps {
	/**
	 * Render the mark in `currentColor` instead of the brand orange — for surfaces
	 * that own the color (a dimmed backer glyph behind the colored center plate).
	 * The `fill` attribute wins over inherited color, so tinting the full-color
	 * mark via `className`/`color` does nothing; this is the only monochrome path.
	 */
	monochrome?: boolean
}

/**
 * The Cloudflare mark. Rendered in brand orange by default (the convention for
 * brand marks here — see `slack.tsx`, `clickhouse.tsx`), which means the fill is
 * fixed and `className`/`color` cannot tint it. Pass `monochrome` when the glyph
 * has to inherit its surface's text color.
 *
 * Source: simple-icons (MIT) — https://simpleicons.org/icons/cloudflare
 */
export const CLOUDFLARE_MARK_PATH =
	"M16.50 16.84c.1475-.5068.09-.9707-.1553-1.31-.2246-.3164-.6045-.499-1.06-.5205l-8.65-.1123a.1559.15 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.02-.084.11-.1484.20-.1562l8.73-.1123c1.03-.0489 2.16-.8868 2.55-1.91l.499-1.30c.0215-.0561.02-.1128.01-.168-.5625-2.54-2.83-4.44-5.54-4.44-2.50 0-4.62 1.61-5.38 3.86-.4927-.3658-1.11-.5625-1.79-.499-1.20.119-2.16 1.08-2.28 2.28-.0283.31-.0069.61.0635.89C1.56 13.17 0 14.77 0 16.75c0 .1748.01.3515.03.5273.01.083.08.1475.16.1475h15.98c.0909 0 .1758-.0645.20-.1553l.12-.4268zm2.75-5.56c-.0771 0-.1611 0-.2383.01-.0566 0-.1054.04-.127.09l-.3378 1.17c-.1475.50-.0918.97.1543 1.31.2256.31.6055.49 1.06.5195l1.84.1133c.0557 0 .1055.02.1329.07.0283.04.0351.10.0214.15-.0283.08-.1132.14-.204.15l-1.92.1123c-1.04.0488-2.15.8867-2.55 1.91l-.1406.35c-.0283.07.0215.14.0986.14h6.59c.0771 0 .1474-.0489.16-.126.11-.4082.17-.837.17-1.28 0-2.60-2.12-4.72-4.73-4.72"

function CloudflareIcon({ size = 24, className, monochrome = false, ...props }: CloudflareIconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill={monochrome ? "currentColor" : "#F38020"}
			aria-hidden="true"
			{...props}
		>
			<path d={CLOUDFLARE_MARK_PATH} />
		</svg>
	)
}

/**
 * Monochrome Cloudflare mark as a plain icon component — for the
 * `ComponentType<{ size, className }>` slots (catalog entries, icon plates) that
 * can't pass the `monochrome` prop themselves.
 */
function CloudflareMonoIcon({ size = 24, className, ...props }: IconProps) {
	return <CloudflareIcon size={size} className={className} monochrome {...props} />
}

export { CloudflareIcon, CloudflareMonoIcon }
