import type { IconProps } from "./icon"

function BellIcon({ size = 24, className, ...props }: IconProps) {
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
				d="m22,18c-1.65,0-3-1.34-3-3v-6c0-3.86-3.13-7-7-7h0c-3.86,0-7,3.13-7,7v6c0,1.65-1.34,3-3,3h20Z"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<path
				d="m10.27,22c.346.59.984,1,1.72,1s1.37-.405,1.72-1h-3.44Z"
				fill="currentColor"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { BellIcon }
