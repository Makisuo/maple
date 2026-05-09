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
				d="M11.07 2H18C19.10 2 20 2.89 20 4V20C20 21.10 19.10 22 18 22H6C4.89 22 4 21.10 4 20V9.07C4 8.54 4.21 8.03 4.58 7.66L9.66 2.58C10.03 2.21 10.54 2 11.07 2Z"
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
