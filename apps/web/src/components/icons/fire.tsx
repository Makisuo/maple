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
				d="M20.7653 12.2334L1.88229 18.8236L3.20033 22.6002L21.5 14.5L20.7653 12.2334Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
			/>
			<path
				d="M11.9828 18.7127L20.7654 22.6002L22.0834 18.8236L16.2957 16.8037"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
			/>
			<path
				d="M8 8.02655C8 7.38572 8.5 4.56097 8.5 4.56097L9.625 5.17073L12 2C12 2 16 5.17073 16 8.02655C16 10.5598 13.9498 12 12 12C10.0502 12 8 10.5598 8 8.02655Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M4.50001 15.4005L2.4657 14.5L3.20035 12.2334L8.26224 14"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
			/>
		</svg>
	)
}
export { FireIcon }
