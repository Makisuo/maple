import type { IconProps } from "./icon"

function PlusIcon({ size = 24, className, ...props }: IconProps) {
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
			<line
				x1="21"
				y1="12"
				x2="3"
				y2="12"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<line
				x1="12"
				y1="3"
				x2="12"
				y2="21"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { PlusIcon }
