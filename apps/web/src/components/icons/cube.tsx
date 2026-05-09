import type { IconProps } from "./icon"

function CubeIcon({ size = 24, className, ...props }: IconProps) {
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
			<path d="M12 22.5V11" stroke="currentColor" strokeWidth="2" />
			<path
				d="M21.5 6.25L22 6L12 11L2 6.00L2.5 6.25"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
			/>
			<path
				d="M22 18.07V5.92L12 1.5L2 5.92V18.07L12 22.5L22 18.07Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
			/>
		</svg>
	)
}
export { CubeIcon }
