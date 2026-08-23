import type { IconProps } from "./icon"

function PixelWindowIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="none"
			aria-hidden="true"
			{...props}
		>
			<path d="M5 21L19 21" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M3 14L3 19" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M13 17L17 17L17 13" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M15 15L15 15.01" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M13 13L13 13.01" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M5 10L8 10" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M21 5L21 19" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M10 5L10 8" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M3 5L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M14 3L19 3" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M5 3L8 3" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
		</svg>
	)
}
export { PixelWindowIcon }
