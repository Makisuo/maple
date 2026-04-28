import type { IconProps } from "./icon"

function EnvelopeIcon({ size = 24, className, ...props }: IconProps) {
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
			<polyline points="2 8 12 13 22 8" stroke="currentColor" strokeMiterlimit="10" strokeWidth="2" />
			<rect
				x="2"
				y="4"
				width="20"
				height="16"
				rx="2"
				ry="2"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { EnvelopeIcon }
