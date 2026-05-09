import type { IconProps } from "./icon"

function ArrowPathIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M3 12a9 9 0 0 1 15.36-6.36L21 8"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				d="M21 3v5h-5"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
				strokeLinejoin="miter"
			/>
			<path
				d="M21 12a9 9 0 0 1-15.36 6.36L3 16"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				d="M3 21v-5h5"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
				strokeLinejoin="miter"
			/>
		</svg>
	)
}

export { ArrowPathIcon }
