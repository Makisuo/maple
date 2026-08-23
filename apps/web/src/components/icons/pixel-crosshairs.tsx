import type { IconProps } from "./icon"

function PixelCrosshairsIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M12 2V5" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M12 22V19" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path
				d="M22.005 11.995L19.005 11.995"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				d="M2.005 11.995L5.005 11.995"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path d="M8 2L16 2" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M6 4L6 4.01" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M18.01 4L18 4" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M4 6L4 6.01" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M20.01 6L20 6" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M2 8L2 16" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M22 8L22 16" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M4.01001 18L4.00001 18" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M20.01 18L20 18" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M6.01001 20L6.00001 20" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M18.01 20L18 20" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M8 22L16 22" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
		</svg>
	)
}
export { PixelCrosshairsIcon }
