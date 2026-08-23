import type { IconProps } from "./icon"

function PixelBracketsCurlyIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M12 16.01V16" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M16 16.01V16" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M8 16.01V16" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M7 3H6" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M17 3H18" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M7 21H6" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M17 21H18" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M2 12H1" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M22 12H23" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M4 10V5" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M20 10V5" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M4 19V14" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M20 19V14" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
		</svg>
	)
}
export { PixelBracketsCurlyIcon }
