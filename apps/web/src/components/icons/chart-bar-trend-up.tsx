import type { IconProps } from "./icon"

function ChartBarTrendUpIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M10 12H14V21H10V12Z" stroke="currentColor" strokeWidth="2" />
			<path d="M18 8H22V21H18V8Z" stroke="currentColor" strokeWidth="2" />
			<path d="M2 16H6V21H2V16Z" stroke="currentColor" strokeWidth="2" />
			<path d="M2 7L6 3L10 7L15 2" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
		</svg>
	)
}
export { ChartBarTrendUpIcon }
