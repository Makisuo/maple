import type { IconProps } from "./icon"

function LogoutIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M16 4V4C16 2.89543 15.1046 2 14 2L6 2C4.89543 2 4 2.89543 4 4L4 20C4 21.1046 4.89543 22 6 22L14 22C15.1046 22 16 21.1046 16 20V20"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M9.99999 12L21.5 12L21 12"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M17.2574 16.2427L21.5 12L17.2574 7.75739"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { LogoutIcon }
