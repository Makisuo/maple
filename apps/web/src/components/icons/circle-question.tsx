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
				d="m9.24,8.36c.422-1.60,1.73-2.44,3.20-2.36,1.45.07,2.79.872,2.73,2.72-.089,2.63-2.88,2.27-3.19,4.77h.011"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { CircleQuestionIcon }
