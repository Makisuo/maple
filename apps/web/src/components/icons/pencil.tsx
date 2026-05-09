import type { IconProps } from "./icon"

function PencilIcon({ size = 24, className, ...props }: IconProps) {
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
				x1="14"
				y1="5"
				x2="19"
				y2="10"
				stroke="currentColor"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<path
				d="m9,20l-6,1,1-6L15.46,3.53c1.38-1.38,3.61-1.38,5,0h0c1.38,1.38,1.38,3.61,0,5l-11.46,11.46Z"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<line
				x1="16.5"
				y1="7.5"
				x2="8"
				y2="16"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { PencilIcon }
