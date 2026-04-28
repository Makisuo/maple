import type { IconProps } from "./icon"

function FileIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M11.0784 2H18C19.1046 2 20 2.89543 20 4V20C20 21.1046 19.1046 22 18 22H6C4.89543 22 4 21.1046 4 20V9.07843C4 8.54799 4.21071 8.03929 4.58579 7.66421L9.66421 2.58579C10.0393 2.21071 10.548 2 11.0784 2Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path d="M4 9H11V2" stroke="currentColor" strokeWidth="2" strokeMiterlimit="10" />
			<path
				d="M8 17H16"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M8 13L11 13"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { FileIcon }
