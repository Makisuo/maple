import type { IconProps } from "./icon"

function DatabaseIcon({ size = 24, className, ...props }: IconProps) {
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
			<path
				d="m3,5v14c0,1.7,4,3,9,3s9-1.3,9-3V5"
				stroke="currentColor"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<ellipse
				cx="12"
				cy="5"
				rx="9"
				ry="3"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<path
				d="m21,12c0,1.7-4,3-9,3s-9-1.3-9-3"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { DatabaseIcon }
