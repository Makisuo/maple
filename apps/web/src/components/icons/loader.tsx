import type { IconProps } from "./icon"

function LoaderIcon({ size = 24, className, ...props }: IconProps) {
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
			<path opacity="0.5" d="M12 19V22" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path d="M12 2V5" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
			<path
				opacity="0.25"
				d="M5.00 11.99L2.00 11.99"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				opacity="0.75"
				d="M22.00 11.99L19.00 11.99"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				opacity="0.38"
				d="M7.05 16.94L4.93 19.06"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				opacity="0.88"
				d="M19.07 4.92L16.95 7.04"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				opacity="0.13"
				d="M7.05 7.04L4.93 4.92"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
			<path
				opacity="0.63"
				d="M19.07 19.06L16.95 16.94"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { LoaderIcon }
