import type { IconProps } from "./icon"

function CircleWarningIcon({ size = 24, className, ...props }: IconProps) {
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
			<line
				x1="12"
				y1="7"
				x2="12"
				y2="13"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<circle cx="12" cy="16.75" r="1.25" fill="currentColor" strokeWidth="0" />
		</svg>
	)
}
export { CircleWarningIcon }
