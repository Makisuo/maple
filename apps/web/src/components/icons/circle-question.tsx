import type { IconProps } from "./icon"

function CircleQuestionIcon({ size = 24, className, ...props }: IconProps) {
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
			<circle cx="12" cy="17.25" r="1.25" fill="currentColor" strokeWidth="0" />
			<path
				d="m9.244,8.369c.422-1.608,1.733-2.44,3.201-2.364,1.45.075,2.799.872,2.737,2.722-.089,2.63-2.884,2.273-3.197,4.773h.011"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { CircleQuestionIcon }
