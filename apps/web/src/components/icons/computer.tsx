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
				d="M16 2L8.00001 2C6.89544 2 6.00001 2.89543 6.00001 4L6.00001 20C6.00001 21.1046 6.89544 22 8.00001 22L16 22C17.1046 22 18 21.1046 18 20L18 4C18 2.89543 17.1046 2 16 2Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M12 18C13.1046 18 14 17.1046 14 16C14 14.8954 13.1046 14 12 14C10.8954 14 10 14.8954 10 16C10 17.1046 10.8954 18 12 18Z"
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
