import type { IconProps } from "./icon"

function ChatBubbleSparkleIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M19.25 7.25L22 6.01V4.98L19.25 3.74L18.01 1H16.98L15.74 3.74L13 4.98V6.01L15.74 7.25L16.98 10H18.01L19.25 7.25Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
			<path
				d="M10 5H3V21H3.41L5.37 17.50L5.66 17H21V10.25L21.77 9.90L23 9.34V19H6.83L4.87 22.49L4.58 23H1V3H10V5Z"
				fill="currentColor"
			/>
		</svg>
	)
}
export { ChatBubbleSparkleIcon }
