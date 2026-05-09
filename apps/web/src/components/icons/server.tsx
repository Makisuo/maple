import type { IconProps } from "./icon"

function ServerIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M12 3V21" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path
				d="M19 3H5C3.89 3 3 3.89 3 5V19C3 20.10 3.89 21 5 21H19C20.10 21 21 20.10 21 19V5C21 3.89 20.10 3 19 3Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path d="M7 7H8" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M7 15H8" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M7 11H8" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M16 7H17" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M16 15H17" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M16 11H17" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
		</svg>
	)
}
export { ServerIcon }
