import type { IconProps } from "./icon"

function FloppyDiskIcon({ size = 24, className, ...props }: IconProps) {
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
			<polyline
				points="7 17 7 13 17 13 17 17"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<path
				d="m19,21H5c-1.105,0-2-.895-2-2V5c0-1.105.895-2,2-2h11l5,5v11c0,1.105-.895,2-2,2Z"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
			<line
				x1="15"
				y1="7"
				x2="15"
				y2="9"
				stroke="currentColor"
				strokeLinecap="square"
				strokeMiterlimit="10"
				strokeWidth="2"
			/>
		</svg>
	)
}
export { FloppyDiskIcon }
