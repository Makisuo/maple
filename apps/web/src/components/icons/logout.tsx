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
				d="M16 4V4C16 2.89 15.10 2 14 2L6 2C4.89 2 4 2.89 4 4L4 20C4 21.10 4.89 22 6 22L14 22C15.10 22 16 21.10 16 20V20"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M9.99 12L21.5 12L21 12"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M17.25 16.24L21.5 12L17.25 7.75"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { LogoutIcon }
