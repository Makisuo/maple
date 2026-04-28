import type { IconProps } from "./icon"

function ClockIcon({ size = 24, className, ...props }: IconProps) {
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
			<circle
				cx="12"
				cy="12"
				r="10"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<polyline
				points="12 6 12 12 16 15"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { ClockIcon }
