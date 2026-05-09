import type { IconProps } from "./icon"

function FireIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M20.76 12.23L1.88 18.82L3.20 22.60L21.5 14.5L20.76 12.23Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
			/>
			<path
				d="M11.98 18.71L20.76 22.60L22.08 18.82L16.29 16.80"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
			/>
			<path
				d="M8 8.02C8 7.38 8.5 4.56 8.5 4.56L9.62 5.17L12 2C12 2 16 5.17 16 8.02C16 10.55 13.94 12 12 12C10.05 12 8 10.55 8 8.02Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M4.50 15.40L2.46 14.5L3.20 12.23L8.26 14"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
			/>
		</svg>
	)
}
export { FireIcon }
