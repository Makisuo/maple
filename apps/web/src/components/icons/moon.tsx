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
				d="M4 11.93C4 16.93 8.05 21 13.06 21C16.48 21 19.45 19.11 21 16.32C20.48 16.41 19.95 16.46 19.41 16.46C14.40 16.46 10.34 12.40 10.34 7.39C10.34 5.80 10.75 4.30 11.48 3C7.23 3.74 4 7.46 4 11.93Z"
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
