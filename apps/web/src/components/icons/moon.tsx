import type { IconProps } from "./icon"

function MoonIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M4 11.9309C4 16.9396 8.0596 21 13.0674 21C16.4803 21 19.4528 19.1141 21 16.3273C20.4852 16.4181 19.9554 16.4655 19.4145 16.4655C14.4068 16.4655 10.3472 12.4051 10.3472 7.39637C10.3472 5.80122 10.7589 4.30225 11.4819 3C7.23006 3.74996 4 7.46316 4 11.9309Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
				strokeLinejoin="bevel"
			/>
		</svg>
	)
}
export { MoonIcon }
