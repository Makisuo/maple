import type { IconProps } from "./icon"

function BluetoothIcon({ size = 24, className, ...props }: IconProps) {
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
			<polyline
				points="5 17 18 6 11 2 11 22 18 17 5 6"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { BluetoothIcon }
