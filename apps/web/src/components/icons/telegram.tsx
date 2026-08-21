import { useId } from "react"
import type { IconProps } from "./icon"

/** The plane, drawn in the official mark's 240×240 coordinate space. */
const PLANE =
	"M54.0684 118.708C89.0967 103.446 112.457 93.3849 124.148 88.5258C157.52 74.6474 164.454 72.2363 168.975 72.1565C169.97 72.1392 172.192 72.3858 173.632 73.5545C174.848 74.5414 175.183 75.8744 175.343 76.8101C175.503 77.7458 175.703 79.8774 175.544 81.5433C173.735 100.545 165.91 146.669 161.929 167.957C160.245 176.965 156.929 179.985 153.719 180.28C146.742 180.923 141.444 175.67 134.687 171.24C124.113 164.308 118.139 159.994 107.874 153.229C96.0112 145.412 103.702 141.115 110.461 134.094C112.23 132.256 142.972 104.297 143.567 101.759C143.641 101.442 143.71 100.259 143.008 99.6343C142.305 99.0098 141.268 99.2234 140.52 99.3933C139.459 99.6343 122.566 110.802 89.8402 132.897C85.0455 136.189 80.7028 137.792 76.8121 137.708C72.5224 137.616 64.2693 135.282 58.1353 133.288C50.6136 130.842 44.6357 129.549 45.1562 125.395C45.4273 123.231 48.4314 121.019 54.0684 118.708Z"

/**
 * The Telegram mark: the brand-blue disc with the white plane, as Telegram
 * ships it. Like `SlackIcon`, the fills are the brand's own — `className` and
 * `color` cannot tint it. Use `TelegramMonoIcon` where the surface owns the
 * color.
 */
function TelegramIcon({ size = 24, className, ...props }: IconProps) {
	const gradientId = useId()
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 240 240"
			width={size}
			height={size}
			className={className}
			aria-hidden="true"
			{...props}
		>
			<defs>
				<linearGradient
					id={gradientId}
					x1="120"
					y1="0"
					x2="120"
					y2="238.5"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#2AABEE" />
					<stop offset="1" stopColor="#229ED9" />
				</linearGradient>
			</defs>
			<circle cx="120" cy="120" r="120" fill={`url(#${gradientId})`} />
			<path fill="#fff" d={PLANE} />
		</svg>
	)
}

/**
 * The plane alone, in `currentColor` — for slots that set the color themselves
 * (icon plates, dimmed backer glyphs) where the full-color disc would ignore
 * them. Cropped to the plane's own bounds so it fills the box like every other
 * monochrome icon here.
 */
function TelegramMonoIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="34 51 152 152"
			width={size}
			height={size}
			className={className}
			fill="currentColor"
			aria-hidden="true"
			{...props}
		>
			<path d={PLANE} />
		</svg>
	)
}

export { TelegramIcon, TelegramMonoIcon }
