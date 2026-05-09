import type { IconProps } from "./icon"

function ComputerIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M16 2L8.00 2C6.89 2 6.00 2.89 6.00 4L6.00 20C6.00 21.10 6.89 22 8.00 22L16 22C17.10 22 18 21.10 18 20L18 4C18 2.89 17.10 2 16 2Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M12 18C13.10 18 14 17.10 14 16C14 14.89 13.10 14 12 14C10.89 14 10 14.89 10 16C10 17.10 10.89 18 12 18Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M10 7H14"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { ComputerIcon }
