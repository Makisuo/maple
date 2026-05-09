import type { IconProps } from "./icon"

function GlobeIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M22 12H2"
				stroke="currentColor"
				strokeWidth="2"
			/>
			<path
				d="M12 22C17.71 16.55 17.71 7.44 12 2"
				stroke="currentColor"
				strokeWidth="2"
				fill="none"
			/>
			<path
				d="M12 22C6.28 16.55 6.28 7.44 12 2"
				stroke="currentColor"
				strokeWidth="2"
				fill="none"
			/>
			<path
				d="M12 22C17.52 22 22 17.52 22 12C22 6.47 17.52 2 12 2C6.47 2 2 6.47 2 12C2 17.52 6.47 22 12 22Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}

export { GlobeIcon }
