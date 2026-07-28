import type { IconProps } from "./icon"

function CursorIcon({ size = 24, className, ...props }: IconProps) {
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
				d="M4.49997 4.50003L16.5 7.50003L13.4981 10.6698L20 17.1715L17.1716 19.9999L10.6697 13.4982L7.49994 16.5001L4.49997 4.50003Z"
				stroke="currentColor"
				strokeWidth="2"
				strokeMiterlimit="10"
				strokeLinecap="square"
			/>
		</svg>
	)
}
export { CursorIcon }
