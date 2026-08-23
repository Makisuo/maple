import type { IconProps } from "./icon"

function CursorPointerIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M7 13V2.99988C7 1.89531 7.89543 0.999878 9 0.999878V0.999878C10.1046 0.999878 11 1.89531 11 2.99988V7.99988L18.2185 9.75154C19.6891 10.1045 20.667 11.4969 20.5 13L19.5 23H8V21L4.96516 17.3909C4.34991 16.823 4 16.0238 4 15.1865V12C4 10.8954 4.89543 9.99999 6 9.99999H6.5"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="2"
				strokeLinecap="square"
			/>
			<path d="M11.5 15V17" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M15.5 15V17" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
		</svg>
	)
}
export { CursorPointerIcon }
