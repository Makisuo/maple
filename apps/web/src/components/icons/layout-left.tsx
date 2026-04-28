import type { IconProps } from "./icon"

function LayoutLeftIcon({ size = 24, className, ...props }: IconProps) {
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
			<line
				x1="6"
				y1="16"
				x2="6"
				y2="8"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { LayoutLeftIcon }
