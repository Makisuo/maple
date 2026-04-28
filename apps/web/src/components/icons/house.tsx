import type { IconProps } from "./icon"

function HouseIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M9 21V16C9 14.3431 10.3431 13 12 13C13.6569 13 15 14.3431 15 16V21"
				stroke="currentColor"
				strokeWidth="2"
			/>
			<path
				d="M12 2L2 9.5V10.5L4 11V21H20V11L22 10.5V9.5L12 2Z"
				stroke="currentColor"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { HouseIcon }
