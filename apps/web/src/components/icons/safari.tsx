import type { IconProps } from "./icon"

// Apple Safari mark, simplified for small sizes: solid blue dial with the
// two-tone compass needle (red toward NE, white toward SW). The original
// Nucleo glyph's ~30 tick marks turn to mud at 14px.
function SafariIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 32 32"
			width={size}
			height={size}
			className={className}
			aria-hidden="true"
			{...props}
		>
			<circle cx="16" cy="16" r="14" fill="#1B9AF7" />
			<path fill="#FF3B30" d="M24.5,7.5l-11.47,5.53,5.94,5.94,5.53-11.47Z" />
			<path fill="#F5F7FA" d="M7.5,24.5l11.47-5.53-5.94-5.94-5.53,11.47Z" />
		</svg>
	)
}

export { SafariIcon }
