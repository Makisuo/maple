import type { IconProps } from "./icon"

function SunIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M12 18C15.31 18 18 15.31 18 12C18 8.68 15.31 6 12 6C8.68 6 6 8.68 6 12C6 15.31 8.68 18 12 18Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path d="M12 1V2" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M12 22V23" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M23 12L22 12" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M2 12L1 12" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path
				d="M19.77 4.22L19.07 4.92"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				d="M4.92 19.07L4.22 19.77"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				d="M19.77 19.77L19.07 19.07"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				d="M4.92 4.92L4.22 4.22"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { SunIcon }
