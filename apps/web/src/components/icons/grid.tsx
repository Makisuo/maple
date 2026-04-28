import type { IconProps } from "./icon"

function GridIcon({ size = 24, className, ...props }: IconProps) {
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
				x="3"
				y="3"
				width="7"
				height="7"
				rx="1"
				ry="1"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<rect
				x="3"
				y="14"
				width="7"
				height="7"
				rx="1"
				ry="1"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<rect
				x="14"
				y="3"
				width="7"
				height="7"
				rx="1"
				ry="1"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<rect
				x="14"
				y="14"
				width="7"
				height="7"
				rx="1"
				ry="1"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { GridIcon }
