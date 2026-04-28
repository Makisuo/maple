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
				d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M8.5 10.5C9.60457 10.5 10.5 9.60457 10.5 8.5C10.5 7.39543 9.60457 6.5 8.5 6.5C7.39543 6.5 6.5 7.39543 6.5 8.5C6.5 9.60457 7.39543 10.5 8.5 10.5Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M15.5 17.5C16.6046 17.5 17.5 16.6046 17.5 15.5C17.5 14.3954 16.6046 13.5 15.5 13.5C14.3954 13.5 13.5 14.3954 13.5 15.5C13.5 16.6046 14.3954 17.5 15.5 17.5Z"
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
