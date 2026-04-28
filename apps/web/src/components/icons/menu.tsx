import type { IconProps } from "./icon"

function MenuIcon({ size = 24, className, ...props }: IconProps) {
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
				x1="2"
				y1="12"
				x2="22"
				y2="12"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<line
				x1="2"
				y1="5"
				x2="22"
				y2="5"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<line
				x1="2"
				y1="19"
				x2="22"
				y2="19"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { MenuIcon }
