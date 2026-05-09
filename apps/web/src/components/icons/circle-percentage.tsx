import type { IconProps } from "./icon"

function CirclePercentageIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M12 22C17.52 22 22 17.52 22 12C22 6.47 17.52 2 12 2C6.47 2 2 6.47 2 12C2 17.52 6.47 22 12 22Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M8.5 10.5C9.60 10.5 10.5 9.60 10.5 8.5C10.5 7.39 9.60 6.5 8.5 6.5C7.39 6.5 6.5 7.39 6.5 8.5C6.5 9.60 7.39 10.5 8.5 10.5Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M15.5 17.5C16.60 17.5 17.5 16.60 17.5 15.5C17.5 14.39 16.60 13.5 15.5 13.5C14.39 13.5 13.5 14.39 13.5 15.5C13.5 16.60 14.39 17.5 15.5 17.5Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M7.5 16.5L12 12L16.5 7.5"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { CirclePercentageIcon }
