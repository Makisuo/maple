import type { IconProps } from "./icon"

function PixelSparkleIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M17 7V7.01" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M13 7V7.01" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M13 11V11.01" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M17 11V11.01" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M15 13V17" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M15 1V5" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path
				d="M11.005 8.995L9.005 8.995"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				d="M21.005 8.995L19.005 8.995"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path d="M9.01001 17L9.00001 17" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M3.01001 6L3.00001 6" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M5.01001 17L5.00001 17" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M7 13L7 15" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M7 19L7 21" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
		</svg>
	)
}
export { PixelSparkleIcon }
