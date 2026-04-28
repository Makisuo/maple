import type { IconProps } from "./icon"

function DotsVerticalIcon({ size = 24, className, ...props }: IconProps) {
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
				r=".75"
				fill="currentColor"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<circle
				cx="12"
				cy="3.75"
				r=".75"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
				fill="currentColor"
			/>
			<circle
				cx="12"
				cy="20.25"
				r=".75"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
				fill="currentColor"
			/>
		</svg>
	)
}
export { DotsVerticalIcon }
