import type { IconProps } from "./icon"

function ShieldIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M21 12.25C21 19 12 22 12 22C12 22 3 19 3 12.25V4.75L12 2.5L21 4.75V12.25Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M12 15.5L8 11.5L12 7.5L16 11.5L12 15.5Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { ShieldIcon }
